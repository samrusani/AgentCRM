import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncMail } from '../src/actions/index.js';
import { buildApp } from '../src/http/app.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { drain, queueOne, statusOf } from './mailHelpers.js';

// The manual check path: AGENTCRM_IMAP_FAKE=1 swaps the real mail servers for the in process fake, and debug routes
// trigger a reply and a bounce.

const env: TestEnvironment = createTestEnvironment();
let app: FastifyInstance;
let plain: FastifyInstance;
const plainEnv: TestEnvironment = createTestEnvironment();

beforeAll(async () => {
  process.env.AGENTCRM_MAIL_RECONCILE_MS = '1000';
  process.env.AGENTCRM_IMAP_FAKE = '1';
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  delete process.env.AGENTCRM_IMAP_FAKE;
  plain = buildApp({ db: plainEnv.db, bus: plainEnv.bus, databasePath: plainEnv.databasePath, logLevel: 'silent', now: plainEnv.ctx.now });
  await plain.ready();
  process.env.AGENTCRM_IMAP_FAKE = '1';
});

afterEach(() => undefined);

afterAll(async () => {
  delete process.env.AGENTCRM_IMAP_FAKE;
  delete process.env.AGENTCRM_MAIL_RECONCILE_MS;
  await app.close();
  await plain.close();
  env.cleanup();
  plainEnv.cleanup();
});

async function call(instance: FastifyInstance, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) {
  const response = await instance.inject({ method, url, payload: payload as object | undefined, headers: { host: '127.0.0.1:4720' } });
  return { status: response.statusCode, body: response.body ? (JSON.parse(response.body) as any) : null };
}

describe('the in process fake mail server', () => {
  it('registers the debug routes only when the flag is set', async () => {
    expect((await call(plain, 'GET', '/api/debug/imap-fake')).status).toBe(404);
    expect((await call(app, 'GET', '/api/debug/imap-fake')).status).toBe(200);
  });

  it('connects, sends, takes a reply and a bounce, and shows a lost connection, all without a real server', async () => {
    const connected = await call(app, 'PUT', '/api/connectors/imap', { preset: 'fastmail', address: 'demo@fake-mail.example', appPassword: 'any-password' });
    expect(connected.status).toBe(201);
    expect(connected.body).toMatchObject({ status: 'connected', settings: { imapOk: true, smtpOk: true, sentMailbox: 'Sent' } });
    // The seeded Inbox message from before connecting is not replayed.
    expect((await syncMail(env.ctx)).messagesStored).toBe(0);

    const replied = queueOne(env, 'Ana', 'ana@lanternrow.invalid');
    const bounced = queueOne(env, 'Bo', 'bo@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, replied)).toBe('accepted');
    expect(statusOf(env, bounced)).toBe('accepted');

    const reply = await call(app, 'POST', '/api/debug/imap-fake/inbound', { from: 'Ana <ana@lanternrow.invalid>', subject: 'Re: hello', text: 'Yes, let us talk.' });
    expect(reply.status).toBe(201);
    expect(reply.body.inReplyTo).toMatch(/^<ac-snd_/);
    const bounce = await call(app, 'POST', '/api/debug/imap-fake/bounce', { to: 'bo@lanternrow.invalid' });
    expect(bounce.status).toBe(201);
    await syncMail(env.ctx);
    expect(statusOf(env, replied)).toBe('replied');
    expect(statusOf(env, bounced)).toBe('bounced');

    // A bounce for an address the fake never sent to is refused with a plain sentence.
    expect((await call(app, 'POST', '/api/debug/imap-fake/bounce', { to: 'nobody@lanternrow.invalid' })).status).toBe(404);

    // A lost connection leaves the message unknown, and the check cannot tell because Sent has no copy.
    await call(app, 'POST', '/api/debug/imap-fake/knobs', { nextSend: 'lost_delivered' });
    const unknown = queueOne(env, 'Cy', 'cy@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, unknown)).toBe('unknown');
    const state = (await call(app, 'GET', '/api/debug/imap-fake')).body;
    expect(state.sendCalls).toBe(3);
    // Turning on the server's own Sent copy now does not add one for a message that was already delivered.
    await call(app, 'POST', '/api/debug/imap-fake/knobs', { sentAutoSave: true });
    env.advance(1500);
    await drain(env);
    expect(statusOf(env, unknown)).toBe('unknown');
  });

  it('shows the honest gap note when the fake mailbox is rebuilt', async () => {
    await call(app, 'POST', '/api/debug/imap-fake/knobs', { changeUidValidity: true });
    await syncMail(env.ctx);
    const connectors = (await call(app, 'GET', '/api/connectors')).body.items;
    expect(connectors.find((item: any) => item.kind === 'imap').statusMessage).toContain('Replies that arrived in between may not be shown here');
  });

  it('fails the login step with a wrong password in the fake', async () => {
    const result = await call(app, 'PUT', '/api/connectors/imap', { preset: 'fastmail', address: 'demo@fake-mail.example', appPassword: 'wrong-password' });
    expect(result.body.status).toBe('error');
    expect(result.body.statusMessage).toMatch(/^IMAP login failed\./);
  });
});
