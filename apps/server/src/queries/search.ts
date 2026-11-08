import type { Db } from '../db.js';
import { type Row, toOpportunity, toOrganization, toPerson } from '../records.js';
import { containsPattern, prefixPattern } from './pagination.js';
import { opportunitySelect } from './opportunities.js';

export const searchLimit = 8;

// A trigram index answers substring matches of 3 or more characters. Shorter queries keep the old LIKE scan.
export const minIndexedQueryLength = 3;
// How many candidates each leg pulls from an index before the old ranking picks the top rows.
export const candidateLimit = 50;
// No searchable expression is longer than 201 characters (a name pair of 100 plus 100 plus the space), so a longer
// query can never match and is answered empty without touching the database. Without the cap, a pathological query of
// tens of thousands of characters makes the FTS5 phrase match run for seconds, and this process is synchronous.
export const maxQueryLength = 256;

// The user's query as one FTS5 string: wrapped in double quotes with any inside double quote doubled. Inside a quoted
// string every FTS5 operator and punctuation mark (*, (, ), -, :, NEAR, AND, OR, NOT, ^) is plain text, so the query is
// never read as syntax. It is bound as a parameter and never put into the SQL text.
export function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

function indexable(trimmed: string): boolean {
  // The tokenizer counts characters, not UTF-16 units, so an emoji is one character.
  return Array.from(trimmed).length >= minIndexedQueryLength;
}

// Runs a candidate query capped at candidateLimit. A leg that fills the cap may hold more matches than it returned, and
// the old ordering could then rank a row that was cut above one that was kept. So a full leg is read again without the
// cap. The answer is still index driven; only the ranking sort sees every match. The result is always the old result.
function readCandidates(read: (limit: number) => string[]): string[] {
  const capped = read(candidateLimit);
  return capped.length < candidateLimit ? capped : read(-1);
}

function idsJson(ids: Iterable<string>): string {
  return JSON.stringify([...ids]);
}

// Ids of organizations in the workspace whose indexed columns match, found through the index and read live.
function matchingOrganizationIds(db: Db, workspaceId: string, columns: string, phrase: string): string[] {
  const statement = db.prepare(
    `SELECT o.id AS id FROM organization_search CROSS JOIN organization o ON o.id = organization_search.entity_id
     WHERE organization_search MATCH ? AND o.workspace_id = ? LIMIT ?`,
  );
  return readCandidates((limit) => (statement.all(`${columns} : ${phrase}`, workspaceId, limit) as { id: string }[]).map((row) => row.id));
}

// Ids of rows of one table whose organization is among the given organizations.
function idsOfOrganizations(db: Db, table: 'person' | 'opportunity', workspaceId: string, organizationIds: string[]): string[] {
  if (organizationIds.length === 0) return [];
  const statement = db.prepare(
    `SELECT id FROM ${table} WHERE workspace_id = ? AND organization_id IN (SELECT value FROM json_each(?)) LIMIT ?`,
  );
  const json = idsJson(organizationIds);
  return readCandidates((limit) => (statement.all(workspaceId, json, limit) as { id: string }[]).map((row) => row.id));
}

export type SearchParentType = 'person' | 'organization' | 'opportunity';
export interface NoteHit {
  id: string;
  snippet: string;
  entityType: SearchParentType;
  entityId: string;
  entityName: string;
}
export interface TaskHit {
  id: string;
  title: string;
  entityType: SearchParentType | null;
  entityId: string | null;
  entityName: string | null;
}
export interface MeetingHit {
  id: string;
  title: string;
  startsAt: string;
}

export const snippetLength = 120;
const zeroWidthCharacters = /[​-‍⁠﻿]/g;

// The largest index at or below `limit` that does not fall between the halves of a surrogate pair.
function cutPoint(value: string, limit: number): number {
  const before = value.charCodeAt(limit - 1);
  return before >= 0xd800 && before <= 0xdbff ? limit - 1 : limit;
}

// Maps an index in body.toLowerCase() back to the matching index in body. Lowercasing usually keeps the length, and
// then the index is the same; a few code points change length (dotted capital I), so those walk the text by code point.
function originalIndex(text: string, lowered: string, loweredIndex: number): number {
  if (lowered.length === text.length) return loweredIndex;
  let consumed = 0;
  let index = 0;
  for (const character of text) {
    if (consumed >= loweredIndex) break;
    consumed += character.toLowerCase().length;
    index += character.length;
  }
  return index;
}

// One line of at most snippetLength characters around the first match: zero width characters removed, newlines turned
// into spaces, both cut on character boundaries (a surrogate pair is never split). Built from the text in code; the
// FTS5 offsets are not used. Plain text, never marked up.
export function buildSnippet(body: string, query: string): string {
  const text = body.replace(zeroWidthCharacters, '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (text.length <= snippetLength) return text;
  const needle = query.trim().toLowerCase();
  const lowered = text.toLowerCase();
  const found = lowered.indexOf(needle);
  const matchAt = found < 0 ? 0 : originalIndex(text, lowered, found);
  const matchLength = Math.min(needle.length, snippetLength);
  let start = Math.max(0, matchAt - Math.floor((snippetLength - matchLength) / 2));
  start = Math.min(start, text.length - snippetLength);
  const startUnit = text.charCodeAt(start);
  if (start > 0 && startUnit >= 0xdc00 && startUnit <= 0xdfff) start += 1;
  return text.slice(start, cutPoint(text, Math.min(text.length, start + snippetLength))).trim();
}

// The parent's live display name, or null when the parent row is gone. The same expression serves notes and tasks.
const parentJoins = (owner: string) => `
  LEFT JOIN person pp ON ${owner}.entity_type = 'person' AND pp.id = ${owner}.entity_id AND pp.workspace_id = ${owner}.workspace_id
  LEFT JOIN organization po ON ${owner}.entity_type = 'organization' AND po.id = ${owner}.entity_id AND po.workspace_id = ${owner}.workspace_id
  LEFT JOIN opportunity pq ON ${owner}.entity_type = 'opportunity' AND pq.id = ${owner}.entity_id AND pq.workspace_id = ${owner}.workspace_id`;
const parentName = "COALESCE(TRIM(pp.first_name || ' ' || pp.last_name), po.name, pq.name)";

// Notes, tasks, and meetings. `phrase` is the quoted FTS5 string for the indexed path and null for the LIKE scan, which
// reads the source tables with the same shape and limits. Candidates come from the index; the rows are then read from
// the source table, filtered by workspace, and ranked with the same LIKE discipline as the groups above.
function searchWidened(db: Db, workspaceId: string, trimmed: string, limit: number, phrase: string | null) {
  const contains = containsPattern(trimmed);
  const prefix = prefixPattern(trimmed);
  const candidates = (table: string, source: string, columns: string): string[] | null => {
    if (phrase === null) return null;
    const statement = db.prepare(
      `SELECT s.id AS id FROM ${table} CROSS JOIN ${source} s ON s.id = ${table}.entity_id
       WHERE ${table} MATCH ? AND s.workspace_id = ? LIMIT ?`,
    );
    return readCandidates((cap) => (statement.all(`${columns} : ${phrase}`, workspaceId, cap) as { id: string }[]).map((row) => row.id));
  };
  const idFilter = (alias: string, ids: string[] | null) => (ids === null ? '' : `AND ${alias}.id IN (SELECT value FROM json_each(?))`);
  const idArgs = (ids: string[] | null) => (ids === null ? [] : [idsJson(ids)]);

  // Notes: newest first, because a note is found by remembering roughly when it was written. An activity whose parent
  // row no longer exists is skipped (the join finds no name), never shown as a blank row.
  const noteIds = candidates('activity_search', 'activity', 'body');
  const notes: NoteHit[] =
    noteIds !== null && noteIds.length === 0
      ? []
      : (
          db
            .prepare(
              `SELECT a.id AS id, a.body AS body, a.entity_type AS entity_type, a.entity_id AS entity_id, ${parentName} AS entity_name
               FROM activity a ${parentJoins('a')}
               WHERE a.workspace_id = ? AND a.kind = 'note' ${idFilter('a', noteIds)}
                 AND lower(a.body) LIKE ? ESCAPE '\\' AND ${parentName} IS NOT NULL
               ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
            )
            .all(workspaceId, ...idArgs(noteIds), contains, limit) as Row[]
        ).map((row) => ({
          id: String(row.id),
          snippet: buildSnippet(String(row.body), trimmed),
          entityType: String(row.entity_type) as SearchParentType,
          entityId: String(row.entity_id),
          entityName: String(row.entity_name),
        }));

  // Tasks: title prefix first, then alphabetical. A task with no linked record, or whose record is gone, carries null
  // parent fields.
  const taskIds = candidates('task_search', 'task', 'title');
  const tasks: TaskHit[] =
    taskIds !== null && taskIds.length === 0
      ? []
      : (
          db
            .prepare(
              `SELECT t.id AS id, t.title AS title, t.entity_type AS entity_type, t.entity_id AS entity_id, ${parentName} AS entity_name
               FROM task t ${parentJoins('t')}
               WHERE t.workspace_id = ? ${idFilter('t', taskIds)} AND lower(t.title) LIKE ? ESCAPE '\\'
               ORDER BY (lower(t.title) LIKE ? ESCAPE '\\') DESC, lower(t.title), t.id LIMIT ?`,
            )
            .all(workspaceId, ...idArgs(taskIds), contains, prefix, limit) as Row[]
        ).map((row) => {
          const linked = row.entity_name !== null && row.entity_name !== undefined;
          return {
            id: String(row.id),
            title: String(row.title),
            entityType: linked ? (String(row.entity_type) as SearchParentType) : null,
            entityId: linked ? String(row.entity_id) : null,
            entityName: linked ? String(row.entity_name) : null,
          };
        });

  // Meetings: title prefix first, then the most recent start.
  const meetingIds = candidates('meeting_search', 'meeting', '{title location notes}');
  const meetings: MeetingHit[] =
    meetingIds !== null && meetingIds.length === 0
      ? []
      : (
          db
            .prepare(
              `SELECT m.id AS id, m.title AS title, m.starts_at AS starts_at FROM meeting m
               WHERE m.workspace_id = ? ${idFilter('m', meetingIds)}
                 AND (lower(m.title) LIKE ? ESCAPE '\\' OR lower(m.location) LIKE ? ESCAPE '\\' OR lower(m.notes) LIKE ? ESCAPE '\\')
               ORDER BY (lower(m.title) LIKE ? ESCAPE '\\') DESC, m.starts_at DESC, m.id LIMIT ?`,
            )
            .all(workspaceId, ...idArgs(meetingIds), contains, contains, contains, prefix, limit) as Row[]
        ).map((row) => ({ id: String(row.id), title: String(row.title), startsAt: String(row.starts_at) }));

  return { notes, tasks, meetings };
}

function searchIndexed(db: Db, workspaceId: string, trimmed: string, limit: number) {
  const contains = containsPattern(trimmed);
  const prefix = prefixPattern(trimmed);
  // The phrase is built from the same JS lowered string the LIKE pattern uses. The trigram tokenizer's own case fold
  // misses several hundred code points that JS lowercases (Cherokee, Georgian Mtavruli, dotted capital I), and the
  // re-filter below only removes rows, so without this the index could miss rows the old scan returned.
  const phrase = ftsPhrase(trimmed.toLowerCase());
  // The organization side is answered by the organization index and joined live, so a rename never reindexes members.
  const orgNameIds = matchingOrganizationIds(db, workspaceId, 'name', phrase);

  // Candidates come from the indexes. The rows are then filtered and ranked by the same SQL the LIKE path uses, over
  // the candidate ids only, so the ranking and the tie order are exactly the old ones.
  const personStatement = db.prepare(
    `SELECT p.id AS id FROM person_search CROSS JOIN person p ON p.id = person_search.entity_id
     WHERE person_search MATCH ? AND p.workspace_id = ? LIMIT ?`,
  );
  const personIds = new Set([
    ...readCandidates((cap) => (personStatement.all(`{name email title} : ${phrase}`, workspaceId, cap) as { id: string }[]).map((row) => row.id)),
    ...idsOfOrganizations(db, 'person', workspaceId, orgNameIds),
  ]);
  const people =
    personIds.size === 0
      ? []
      : (
          db
            .prepare(
              `SELECT p.*, o.name AS organization_name FROM person p LEFT JOIN organization o ON o.id = p.organization_id
               WHERE p.workspace_id = ? AND p.id IN (SELECT value FROM json_each(?))
                 AND (lower(p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\'
                 OR lower(p.email) LIKE ? ESCAPE '\\' OR lower(o.name) LIKE ? ESCAPE '\\' OR lower(p.title) LIKE ? ESCAPE '\\')
               ORDER BY (lower(p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\' OR lower(p.last_name) LIKE ? ESCAPE '\\') DESC,
                 lower(p.last_name), lower(p.first_name), p.id LIMIT ?`,
            )
            .all(workspaceId, idsJson(personIds), contains, contains, contains, contains, prefix, prefix, limit) as Row[]
        ).map(toPerson);

  const organizationIds = matchingOrganizationIds(db, workspaceId, '{name domain}', phrase);
  const organizations =
    organizationIds.length === 0
      ? []
      : (
          db
            .prepare(
              `SELECT * FROM organization o WHERE o.workspace_id = ? AND o.id IN (SELECT value FROM json_each(?))
               AND (lower(o.name) LIKE ? ESCAPE '\\' OR lower(o.domain) LIKE ? ESCAPE '\\')
               ORDER BY (lower(o.name) LIKE ? ESCAPE '\\') DESC, lower(o.name), o.id LIMIT ?`,
            )
            .all(workspaceId, idsJson(organizationIds), contains, contains, prefix, limit) as Row[]
        ).map(toOrganization);

  const opportunityStatement = db.prepare(
    `SELECT op.id AS id FROM opportunity_search CROSS JOIN opportunity op ON op.id = opportunity_search.entity_id
     WHERE opportunity_search MATCH ? AND op.workspace_id = ? LIMIT ?`,
  );
  const opportunityIds = new Set([
    ...readCandidates((cap) => (opportunityStatement.all(`name : ${phrase}`, workspaceId, cap) as { id: string }[]).map((row) => row.id)),
    ...idsOfOrganizations(db, 'opportunity', workspaceId, orgNameIds),
  ]);
  const opportunities =
    opportunityIds.size === 0
      ? []
      : (
          db
            .prepare(
              `${opportunitySelect} WHERE op.workspace_id = ? AND op.id IN (SELECT value FROM json_each(?))
               AND (lower(op.name) LIKE ? ESCAPE '\\' OR lower(o.name) LIKE ? ESCAPE '\\')
               ORDER BY (lower(op.name) LIKE ? ESCAPE '\\') DESC, lower(op.name), op.id LIMIT ?`,
            )
            .all(workspaceId, idsJson(opportunityIds), contains, contains, prefix, limit) as Row[]
        ).map(toOpportunity);

  return { people, organizations, opportunities, ...searchWidened(db, workspaceId, trimmed, limit, phrase) };
}

// The scan the search used before the indexes. Still the path for queries shorter than 3 characters, and the reference
// the tests compare the indexed path against.
export function searchScan(db: Db, workspaceId: string, trimmed: string, limit: number) {
  const contains = containsPattern(trimmed);
  const prefix = prefixPattern(trimmed);

  const people = (
    db
      .prepare(
        `SELECT p.*, o.name AS organization_name FROM person p LEFT JOIN organization o ON o.id = p.organization_id
         WHERE p.workspace_id = ? AND (lower(p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\'
           OR lower(p.email) LIKE ? ESCAPE '\\' OR lower(o.name) LIKE ? ESCAPE '\\' OR lower(p.title) LIKE ? ESCAPE '\\')
         ORDER BY (lower(p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\' OR lower(p.last_name) LIKE ? ESCAPE '\\') DESC,
           lower(p.last_name), lower(p.first_name), p.id LIMIT ?`,
      )
      .all(workspaceId, contains, contains, contains, contains, prefix, prefix, limit) as Row[]
  ).map(toPerson);

  const organizations = (
    db
      .prepare(
        `SELECT * FROM organization o WHERE o.workspace_id = ?
         AND (lower(o.name) LIKE ? ESCAPE '\\' OR lower(o.domain) LIKE ? ESCAPE '\\')
         ORDER BY (lower(o.name) LIKE ? ESCAPE '\\') DESC, lower(o.name), o.id LIMIT ?`,
      )
      .all(workspaceId, contains, contains, prefix, limit) as Row[]
  ).map(toOrganization);

  const opportunities = (
    db
      .prepare(
        `${opportunitySelect} WHERE op.workspace_id = ?
         AND (lower(op.name) LIKE ? ESCAPE '\\' OR lower(o.name) LIKE ? ESCAPE '\\')
         ORDER BY (lower(op.name) LIKE ? ESCAPE '\\') DESC, lower(op.name), op.id LIMIT ?`,
      )
      .all(workspaceId, contains, contains, prefix, limit) as Row[]
  ).map(toOpportunity);

  return { people, organizations, opportunities, ...searchWidened(db, workspaceId, trimmed, limit, null) };
}

function emptyResult() {
  return {
    people: [] as ReturnType<typeof toPerson>[],
    organizations: [] as ReturnType<typeof toOrganization>[],
    opportunities: [] as ReturnType<typeof toOpportunity>[],
    notes: [] as NoteHit[],
    tasks: [] as TaskHit[],
    meetings: [] as MeetingHit[],
  };
}

export function searchAll(db: Db, workspaceId: string, query: string, limit: number = searchLimit) {
  // A NUL byte cannot occur in stored text, so such a query matches nothing. Answering it early also matters for the
  // index path, where FTS5 reads a bound string as ending at the first NUL, which would break the quoted phrase.
  if (query.includes('\0')) return emptyResult();
  const trimmed = query.trim();
  if (trimmed.length === 0) return emptyResult();
  if (Array.from(trimmed).length > maxQueryLength) return emptyResult();
  return indexable(trimmed) ? searchIndexed(db, workspaceId, trimmed, limit) : searchScan(db, workspaceId, trimmed, limit);
}
