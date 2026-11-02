import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { type AgentmailStub, startAgentmailStub, stubAgentmailKey, stubInboxId, useAgentmailStub } from './agentmailStub.js';
import { createTestEnvironment } from './helpers.js';
import { addDraft, addPerson, approve, stage, statusOf } from './mailHelpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let stub: AgentmailStub;
let restore: () => void;

beforeAll(async () => {
  stub = await startAgentmailStub();
  restore = useAgentmailStub(stub);
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterEach(() => {
  stub.reset();
});

afterAll(async () => {
  await app.close();
  await stub.close();
  restore();
  env.cleanup();
});

async function call(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload: payload as object | undefined, headers: { host: '127.0.0.1:4720' } });
  return { status: response.statusCode, text: response.body, body: response.body ? (JSON.parse(response.body) as Record<string, any>) : null };
}

describe('agentmail connector', () => {
  it('needs a connector before listing or creating inboxes', async () => {
    const list = await call('GET', '/api/connectors/agentmail/inboxes');
    expect(list.status).toBe(409);
    expect(list.body!.error.message).toContain('Settings');
    expect((await call('POST', '/api/connectors/agentmail/inboxes', {})).status).toBe(409);
    expect((await call('PUT', '/api/connectors/agentmail', { inboxId: stubInboxId })).status).toBe(400);
    expect((await call('DELETE', '/api/connectors/agentmail')).status).toBe(404);
  });

  it('rejects a bad key and stores nothing', async () => {
    const response = await call('PUT', '/api/connectors/agentmail', { token: 'am_wrongkey0000' });
    expect(response.status).toBe(400);
    expect(response.body!.error.code).toBe('validation');
    expect(response.text).not.toContain('wrongkey0000');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM connector').get()).toEqual({ n: 0 });
  });

  it('validates the key with a one item list, stores it, and masks it everywhere', async () => {
    const created = await call('PUT', '/api/connectors/agentmail', { token: stubAgentmailKey });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'agentmail',
      status: 'connected',
      statusMessage: null,
      tokenMasked: '****1234',
      settings: { inboxId: null, inboxEmail: null, lastMessageTimestamp: null, seenEventId: null },
    });
    expect(created.text).not.toContain(stubAgentmailKey);
    expect(created.body).not.toHaveProperty('secret');
    expect(stub.state.requests[0]).toMatchObject({ method: 'GET', path: '/inboxes', query: { limit: '1' } });
    expect(stub.state.authHeaders[0]).toBe(`Bearer ${stubAgentmailKey}`);

    const list = await call('GET', '/api/connectors');
    expect(list.text).not.toContain(stubAgentmailKey);
    const audits = env.db.prepare('SELECT detail FROM audit_event').all() as { detail: string }[];
    expect(audits.some((row) => row.detail.includes(stubAgentmailKey) || row.detail.includes('1234'))).toBe(false);
    const stored = env.db.prepare("SELECT secret FROM connector WHERE kind = 'agentmail'").get() as { secret: string };
    expect(stored.secret).toBe(stubAgentmailKey);
  });

  it('lists inboxes in any documented shape', async () => {
    for (const shape of ['inboxes', 'items', 'bare'] as const) {
      stub.state.inboxListShape = shape;
      const list = await call('GET', '/api/connectors/agentmail/inboxes');
      expect(list.status).toBe(200);
      expect(list.body).toEqual({ items: [{ id: stubInboxId, email: stubInboxId }], nextCursor: null });
    }
  });

  it('creates an inbox idempotently with a client id that has no @', async () => {
    const first = await call('POST', '/api/connectors/agentmail/inboxes', { username: 'outreach' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: 'outreach@stub-mail.invalid', email: 'outreach@stub-mail.invalid' });
    const second = await call('POST', '/api/connectors/agentmail/inboxes', { username: 'outreach' });
    expect(second.body).toEqual(first.body);
    expect(stub.state.inboxes.filter((inbox) => inbox.email.startsWith('outreach@'))).toHaveLength(1);
    const posts = stub.state.requests.filter((request) => request.method === 'POST');
    for (const post of posts) {
      const clientId = (post.body as { client_id: string }).client_id;
      expect(clientId).not.toContain('@');
      expect(clientId).toContain(env.workspaceId);
    }
    const noName = await call('POST', '/api/connectors/agentmail/inboxes', {});
    expect(noName.status).toBe(201);
    expect((await call('POST', '/api/connectors/agentmail/inboxes', { username: 'bad@name' })).status).toBe(400);
  });

  it('selects an inbox only when it exists on the account', async () => {
    stub.state.inboxes.push({ inbox_id: 'second@stub-mail.invalid', email: 'second@stub-mail.invalid', created_at: '2026-01-02T00:00:00.000Z' });
    const missing = await call('PUT', '/api/connectors/agentmail', { inboxId: 'nobody@stub-mail.invalid' });
    expect(missing.status).toBe(400);
    expect(missing.body!.error.message).toContain('not found');

    const selected = await call('PUT', '/api/connectors/agentmail', { inboxId: stubInboxId });
    expect(selected.status).toBe(200);
    expect(selected.body!.settings).toMatchObject({ inboxId: stubInboxId, inboxEmail: stubInboxId, seenEventId: null });
    expect(typeof selected.body!.settings.lastMessageTimestamp).toBe('string');
    expect(selected.body!.tokenMasked).toBe('****1234');

    const byEmail = await call('PUT', '/api/connectors/agentmail', { inboxEmail: 'SECOND@stub-mail.invalid' });
    expect(byEmail.body!.settings).toMatchObject({ inboxId: 'second@stub-mail.invalid', inboxEmail: 'second@stub-mail.invalid' });
    expect((await call('PUT', '/api/connectors/agentmail', {})).status).toBe(400);
  });

  it('blocks queued messages of the old inbox when another inbox is chosen', async () => {
    await call('PUT', '/api/connectors/agentmail', { inboxId: stubInboxId });
    const person = addPerson(env, 'Moe', 'moe@lanternrow.invalid');
    const staged = stage(env, [addDraft(env, person.id, 'Hello', 'Body')]);
    approve(env, staged.approval!.id);
    stub.state.inboxes.push({ inbox_id: 'second@stub-mail.invalid', email: 'second@stub-mail.invalid', created_at: '2026-01-02T00:00:00.000Z' });
    await call('PUT', '/api/connectors/agentmail', { inboxId: 'second@stub-mail.invalid' });
    expect(statusOf(env, staged.intents[0]!.id)).toBe('blocked');
  });

  it('keeps the saved inbox when the key is replaced, and drops it if the new account lacks it', async () => {
    await call('PUT', '/api/connectors/agentmail', { inboxId: stubInboxId });
    stub.state.apiKey = 'am_second_key_9999';
    const kept = await call('PUT', '/api/connectors/agentmail', { token: 'am_second_key_9999' });
    expect(kept.body!.settings.inboxId).toBe(stubInboxId);
    expect(kept.body!.tokenMasked).toBe('****9999');
    stub.state.inboxes = [];
    stub.state.apiKey = stubAgentmailKey;
    const dropped = await call('PUT', '/api/connectors/agentmail', { token: stubAgentmailKey });
    expect(dropped.body!.settings).toMatchObject({ inboxId: null, inboxEmail: null });
  });

  it('flags the connector when the saved key is rejected and asks for a new one', async () => {
    stub.state.apiKey = 'am_changed_elsewhere';
    const list = await call('GET', '/api/connectors/agentmail/inboxes');
    expect(list.status).toBe(409);
    expect(list.text).not.toContain(stubAgentmailKey);
    const connectors = await call('GET', '/api/connectors');
    const agentmail = connectors.body!.items.find((item: any) => item.kind === 'agentmail');
    expect(agentmail).toMatchObject({ status: 'error', statusMessage: expect.stringContaining('AgentMail rejected') });
    stub.state.apiKey = stubAgentmailKey;
    const repaired = await call('PUT', '/api/connectors/agentmail', { token: stubAgentmailKey });
    expect(repaired.body!.status).toBe('connected');
  });

  it('disconnects and removes the key', async () => {
    const removed = await call('DELETE', '/api/connectors/agentmail');
    expect(removed.status).toBe(204);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM connector WHERE kind = 'agentmail'").get()).toEqual({ n: 0 });
    expect((await call('DELETE', '/api/connectors/agentmail')).status).toBe(404);
  });
});
