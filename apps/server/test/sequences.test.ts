import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyChanges,
  createContext,
  createSequence,
  deleteSequence,
  prepareSendIntents,
  proposeChanges,
  updateSequence,
  withActor,
} from '../src/actions/index.js';
import { assertWithinCeiling } from '../src/actions/followupRules.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { packageRoot } from '../src/paths.js';
import { getSequence, listSequences } from '../src/queries/sequences.js';
import { type AgentmailStub, startAgentmailStub, useAgentmailStub } from './agentmailStub.js';
import { createTestEnvironment } from './helpers.js';
import { addDraft, addPerson, connectMail } from './mailHelpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let agentmail: AgentmailStub;
let restoreAgentmail: () => void;
const events: DomainEvent[] = [];
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  agentmail = await startAgentmailStub();
  restoreAgentmail = useAgentmailStub(agentmail);
  env.bus.subscribe((event) => events.push(event));
  await connectMail(env);
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await agentmail.close();
  restoreAgentmail();
  env.cleanup();
});

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await app.inject({ method, url, headers: { ...host, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: response.body ? (response.json() as Record<string, any>) : {} };
}

function rejected(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('Expected the call to be refused.');
}

const step = (waitDays: number, n = 1) => ({ waitDays, body: `Follow-up text number ${n} for a sequence.` });
const audits = (action: string) =>
  (env.db.prepare('SELECT entity_id AS entityId, detail FROM audit_event WHERE action = ? ORDER BY rowid').all(action) as { entityId: string; detail: string }[]).map((row) => ({
    entityId: row.entityId,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
  }));

describe('sequence CRUD', () => {
  it('creates, lists newest first, renames, edits steps, and deletes with audits and record events', () => {
    const first = createSequence(env.ctx, { name: '  Gentle nudges  ', steps: [step(3), step(5, 2)] });
    expect(first).toMatchObject({ name: 'Gentle nudges', version: 1, steps: [step(3), step(5, 2)] });
    expect(first.id).toMatch(/^sqn_/);
    const second = createSequence(env.ctx, { name: 'Second', steps: [step(1)] });
    expect(listSequences(env.db, env.workspaceId).map((item) => item.id).slice(0, 2)).toEqual([second.id, first.id]);

    const renamed = updateSequence(env.ctx, first.id, { expectedVersion: 1, fields: { name: 'Renamed' } });
    expect(renamed).toMatchObject({ name: 'Renamed', version: 2, steps: first.steps });
    const edited = updateSequence(env.ctx, first.id, { expectedVersion: 2, fields: { steps: [step(7, 9)] } });
    expect(edited).toMatchObject({ version: 3, name: 'Renamed', steps: [step(7, 9)] });
    expect(rejected(() => updateSequence(env.ctx, first.id, { expectedVersion: 1, fields: { name: 'Stale' } })).code).toBe('version_conflict');

    deleteSequence(env.ctx, second.id);
    expect(getSequence(env.db, env.workspaceId, second.id)).toBeNull();
    expect(rejected(() => deleteSequence(env.ctx, second.id)).code).toBe('not_found');

    expect(audits('sequence.create').map((entry) => entry.entityId)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(audits('sequence.update').filter((entry) => entry.entityId === first.id)).toHaveLength(2);
    expect(audits('sequence.delete').at(-1)).toMatchObject({ entityId: second.id });
    expect(events.some((event) => event.type === 'record_updated' && event.entityType === 'sequence' && event.entityId === first.id)).toBe(true);
    deleteSequence(env.ctx, first.id);
  });

  it('enforces one to five steps and the same step bounds as staged follow-ups', () => {
    const bad: unknown[] = [
      [],
      [1, 2, 3, 4, 5, 6].map((n) => step(2, n)),
      [{ waitDays: 0, body: 'A perfectly fine follow-up.' }],
      [{ waitDays: 31, body: 'A perfectly fine follow-up.' }],
      [{ waitDays: 1.5, body: 'A perfectly fine follow-up.' }],
      [{ waitDays: 2, body: '   too short ' }],
      [{ waitDays: 2, body: 'x'.repeat(2001) }],
      [{ waitDays: 2, body: 'A perfectly fine follow-up.', extra: true }],
    ];
    for (const steps of bad) expect(rejected(() => createSequence(env.ctx, { name: 'Bad', steps })).code).toBe('validation');
    const five = createSequence(env.ctx, { name: 'Five', steps: [1, 2, 3, 4, 5].map((n) => step(3, n)) });
    expect(five.steps).toHaveLength(5);
    expect(createSequence(env.ctx, { name: 'Trimmed', steps: [{ waitDays: 30, body: '  0123456789  ' }] }).steps[0]!.body).toBe('0123456789');
    deleteSequence(env.ctx, five.id);
  });

  it('refuses waits that pass the 90 day ceiling, naming it, on create and on update', () => {
    // Contract: waits that add up to 90 days or more can only ever expire, so they are refused (89 is the most).
    const over = [30, 30, 30].map((n) => step(n));
    const error = rejected(() => createSequence(env.ctx, { name: 'Too long', steps: over }));
    expect(error.code).toBe('validation');
    expect(error.message).toBe('The waits add up to 90 days; follow-ups stop after 90 days. Shorten a wait or remove a step.');
    const ok = createSequence(env.ctx, { name: 'At the edge', steps: [30, 30, 29].map((n) => step(n)) });
    expect(rejected(() => updateSequence(env.ctx, ok.id, { expectedVersion: 1, fields: { steps: [30, 30, 30, 1].map((n) => step(n)) } })).message).toContain('add up to 91 days');
    expect(getSequence(env.db, env.workspaceId, ok.id)!.version).toBe(1);
    expect(() => assertWithinCeiling([{ waitDays: 89 }])).not.toThrow();
    deleteSequence(env.ctx, ok.id);
  });

  it('refuses empty, over long, and control character names, and an empty edit', () => {
    for (const name of ['', '   ', 'x'.repeat(201), 'bad\u0000name', 'tab\tname', 'line\nbreak', 'del\u007fname']) {
      expect(rejected(() => createSequence(env.ctx, { name, steps: [step(2)] })).code).toBe('validation');
    }
    expect(createSequence(env.ctx, { name: 'x'.repeat(200), steps: [step(2)] }).name).toHaveLength(200);
    const keep = createSequence(env.ctx, { name: 'Keep', steps: [step(2)] });
    expect(rejected(() => updateSequence(env.ctx, keep.id, { expectedVersion: 1, fields: { name: 'a\u0007b' } })).code).toBe('validation');
    expect(rejected(() => updateSequence(env.ctx, keep.id, { expectedVersion: 1, fields: {} })).code).toBe('validation');
    expect(rejected(() => updateSequence(env.ctx, keep.id, { expectedVersion: 1, fields: { name: 'K', extra: 1 } })).code).toBe('validation');
    expect(listSequences(env.db, env.workspaceId).filter((item) => item.name.includes('\u0000'))).toHaveLength(0);
    deleteSequence(env.ctx, keep.id);
  });

  it('is isolated by workspace', () => {
    env.db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_seq2', '2026-03-02T00:00:00.000Z', 'Other', 'startup-fundraising');
    const other = createContext(env.db, 'wsp_seq2', { bus: env.bus, now: env.ctx.now });
    const theirs = createSequence(other, { name: 'Theirs', steps: [step(2)] });
    const mine = createSequence(env.ctx, { name: 'Mine', steps: [step(2)] });
    expect(listSequences(env.db, env.workspaceId).some((item) => item.id === theirs.id)).toBe(false);
    expect(listSequences(env.db, 'wsp_seq2').map((item) => item.id)).toEqual([theirs.id]);
    expect(rejected(() => updateSequence(env.ctx, theirs.id, { expectedVersion: 1, fields: { name: 'Hijack' } })).code).toBe('not_found');
    expect(rejected(() => deleteSequence(env.ctx, theirs.id)).code).toBe('not_found');
    expect(getSequence(env.db, 'wsp_seq2', theirs.id)!.name).toBe('Theirs');
    deleteSequence(env.ctx, mine.id);
    deleteSequence(other, theirs.id);
  });
});

describe('staging with the five step cap and the ceiling', () => {
  const stageWith = (steps: unknown) => {
    const person = addPerson(env, 'Stage', `stage${Math.random().toString(16).slice(2)}@lanternrow.invalid`);
    const draft = addDraft(env, person.id, 'Hello there', 'Hi, a message.');
    return () => prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups: { steps } });
  };

  it('refuses six steps, refuses 90 or more days with the honest message, and accepts five within the ceiling', () => {
    expect(stageWith([1, 2, 3, 4, 5, 6].map((n) => step(2, n)))).toThrow(AppError);
    const refusal = rejected(stageWith([30, 30, 30].map((n) => step(n))));
    expect(refusal.message).toBe('The waits add up to 90 days; follow-ups stop after 90 days. Shorten a wait or remove a step.');
    expect(rejected(stageWith([30, 30, 30, 1, 1].map((n) => step(n)))).message).toContain('add up to 92 days');
    const staged = stageWith([30, 30, 20, 5, 4].map((n, at) => step(n, at + 1)))();
    expect((staged.approval!.payload as any).followups.steps).toHaveLength(5);
    expect(staged.intents).toHaveLength(1);
  });

  it('stages steps copied from a sequence, and deleting the sequence leaves the approval payload untouched', () => {
    const saved = createSequence(env.ctx, { name: 'Copied', steps: [step(2, 1), step(3, 2), step(4, 3)] });
    const person = addPerson(env, 'Copy', 'copy@lanternrow.invalid');
    const draft = addDraft(env, person.id, 'Hello copy', 'Hi, a message.');
    const staged = prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups: { steps: saved.steps } });
    deleteSequence(env.ctx, saved.id);
    const row = env.db.prepare('SELECT payload FROM approval WHERE id = ?').get(staged.approval!.id) as { payload: string };
    expect(JSON.parse(row.payload).followups.steps).toEqual(saved.steps);
    expect(env.db.prepare('SELECT status FROM send_intent WHERE id = ?').get(staged.intents[0]!.id)).toMatchObject({ status: 'awaiting_approval' });
    expect(readFileSync(path.join(packageRoot, 'src/actions/sendIntents.ts'), 'utf8')).not.toMatch(/sequence/i);
  });
});

describe('http', () => {
  it('serves the four endpoints with a 204 delete and refuses a bad ceiling', async () => {
    const created = await call('POST', '/api/sequences', { name: 'Http', steps: [step(2)] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Http', version: 1 });
    expect((await call('POST', '/api/sequences', { name: 'Http', steps: [30, 30, 30].map((n) => step(n)) })).status).toBe(400);
    const listed = await call('GET', '/api/sequences');
    expect(listed.status).toBe(200);
    expect(listed.body.items[0]).toMatchObject({ id: created.body.id });
    expect(listed.body.nextCursor).toBeNull();
    const patched = await call('PATCH', `/api/sequences/${created.body.id}`, { expectedVersion: 1, fields: { name: 'Http 2' } });
    expect(patched.body).toMatchObject({ name: 'Http 2', version: 2 });
    expect((await call('PATCH', `/api/sequences/${created.body.id}`, { expectedVersion: 1, fields: { name: 'Stale' } })).status).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/sequences/${created.body.id}`, headers: host })).statusCode).toBe(204);
    expect((await call('DELETE', `/api/sequences/${created.body.id}`)).status).toBe(404);
  });

  it('refuses a cross-site origin like other settings writes', async () => {
    const response = await call('POST', '/api/sequences', { name: 'Evil', steps: [step(2)] }, { origin: 'https://evil.example' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(listSequences(env.db, env.workspaceId).some((item) => item.name === 'Evil')).toBe(false);
  });
});

describe('agent surfaces stay closed', () => {
  it('has no sequence entity type for proposals and no MCP or model facing mention', () => {
    const agent = withActor(env.ctx, 'agent:probe');
    const saved = createSequence(env.ctx, { name: 'Closed', steps: [step(2)] });
    for (const run of [
      () => proposeChanges(agent, { changes: [{ entityType: 'sequence', id: saved.id, fields: { name: 'Hacked' } }] }),
      () => applyChanges(agent, { proposalHash: 'a'.repeat(64), changes: [{ entityType: 'sequence', id: saved.id, expectedVersion: 1, fields: { name: 'Hacked' } }] }),
    ]) {
      expect(rejected(run).code).toBe('validation');
    }
    expect(getSequence(env.db, env.workspaceId, saved.id)!.name).toBe('Closed');
    for (const file of ['src/mcp/server.ts', 'src/agent/modelChat.ts', 'src/agent/message.ts']) {
      expect(readFileSync(path.join(packageRoot, file), 'utf8').toLowerCase()).not.toContain('sequence');
    }
    deleteSequence(env.ctx, saved.id);
  });
});
