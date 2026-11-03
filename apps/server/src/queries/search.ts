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
    ...readCandidates((cap) => (personStatement.all(`{name email} : ${phrase}`, workspaceId, cap) as { id: string }[]).map((row) => row.id)),
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
                 OR lower(p.email) LIKE ? ESCAPE '\\' OR lower(o.name) LIKE ? ESCAPE '\\')
               ORDER BY (lower(p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\' OR lower(p.last_name) LIKE ? ESCAPE '\\') DESC,
                 lower(p.last_name), lower(p.first_name), p.id LIMIT ?`,
            )
            .all(workspaceId, idsJson(personIds), contains, contains, contains, prefix, prefix, limit) as Row[]
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

  return { people, organizations, opportunities };
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
           OR lower(p.email) LIKE ? ESCAPE '\\' OR lower(o.name) LIKE ? ESCAPE '\\')
         ORDER BY (lower(p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\' OR lower(p.last_name) LIKE ? ESCAPE '\\') DESC,
           lower(p.last_name), lower(p.first_name), p.id LIMIT ?`,
      )
      .all(workspaceId, contains, contains, contains, prefix, prefix, limit) as Row[]
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

  return { people, organizations, opportunities };
}

export function searchAll(db: Db, workspaceId: string, query: string, limit: number = searchLimit) {
  // A NUL byte cannot occur in stored text, so such a query matches nothing. Answering it early also matters for the
  // index path, where FTS5 reads a bound string as ending at the first NUL, which would break the quoted phrase.
  if (query.includes('\0')) return { people: [], organizations: [], opportunities: [] };
  const trimmed = query.trim();
  if (trimmed.length === 0) return { people: [], organizations: [], opportunities: [] };
  if (Array.from(trimmed).length > maxQueryLength) return { people: [], organizations: [], opportunities: [] };
  return indexable(trimmed) ? searchIndexed(db, workspaceId, trimmed, limit) : searchScan(db, workspaceId, trimmed, limit);
}
