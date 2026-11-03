import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { disconnectImapConnector, setMailProvider } from '../src/actions/index.js';
import { buildApp } from '../src/http/app.js';
import { getConnector } from '../src/queries/connectors.js';
import { type AgentmailStub, startAgentmailStub, useAgentmailStub } from './agentmailStub.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { connectImap, connectMail, drain, intentOf, queueOne, statusOf } from './mailHelpers.js';
import { type FakeMailTransport, stubImapAddress, stubImapPassword, useMailTransportStub } from './mailTransportStub.js';

let stub: FakeMailTransport;
let restore: () => void;
let agentmail: AgentmailStub;
let restoreAgentmail: () => void;
const environments: TestEnvironment[] = [];
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  ({ stub, restore } = useMailTransportStub());
  agentmail = await startAgentmailStub();
  restoreAgentmail = useAgentmailStub(agentmail);
});

afterEach(() => {
  stub.reset();
  agentmail.reset();
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await agentmail.close();
  restoreAgentmail();
  restore();
  for (const env of environments) env.cleanup();
});

function freshEnv(): TestEnvironment {
  const env = createTestEnvironment();
  environments.push(env);
  return env;
}

async function appFor(env: TestEnvironment) {
  const app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  apps.push(app);
  return async (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, payload: payload as object | undefined, headers: { host: '127.0.0.1:4720' } });
    return {
      status: response.statusCode,
      text: response.body,
      body: response.body && response.headers['content-type']?.toString().includes('json') ? (JSON.parse(response.body) as any) : null,
    };
  };
}

const realAddress = 'maren.testwell@lanternrow.invalid';

describe('presets map their servers and login names', () => {
  it('iCloud: IMAP logs in with the local part, SMTP with the full address, over STARTTLS on 587', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const response = await call('PUT', '/api/connectors/imap', { preset: 'icloud', address: 'Sam.Smith@iCloud.com', appPassword: 'abcd-efgh-ijkl-mnop' });
    expect(response.status).toBe(201);
    const settings = stub.verifyCalls[0]!;
    expect(settings.imap).toEqual({ host: 'imap.mail.me.com', port: 993, username: 'sam.smith', password: 'abcd-efgh-ijkl-mnop' });
    expect(settings.smtp).toEqual({ host: 'smtp.mail.me.com', port: 587, tls: 'starttls', username: 'sam.smith@icloud.com', password: 'abcd-efgh-ijkl-mnop' });
    expect(response.body.settings).toMatchObject({
      preset: 'icloud',
      address: 'sam.smith@icloud.com',
      username: 'sam.smith',
      smtpUsername: 'sam.smith@icloud.com',
      imapHost: 'imap.mail.me.com',
      imapPort: 993,
      smtpHost: 'smtp.mail.me.com',
      smtpPort: 587,
      smtpTls: 'starttls',
    });
  });

  it('iCloud: a login that differs from the sending address (an alias) is used for both logins', async () => {
    const env = freshEnv();
    await connectImap(env, { preset: 'icloud', address: 'alias@icloud.com', username: 'Real.Id@icloud.com' });
    const settings = stub.verifyCalls[0]!;
    expect(settings.imap.username).toBe('Real.Id');
    expect(settings.smtp.username).toBe('Real.Id@icloud.com');
    expect(settings.address).toBe('alias@icloud.com');
  });

  it('Fastmail: the full address for both, TLS on 465', async () => {
    const env = freshEnv();
    const { connector } = await connectImap(env, { preset: 'fastmail', address: 'me@fastmail.example' });
    const settings = stub.verifyCalls[0]!;
    expect(settings.imap).toMatchObject({ host: 'imap.fastmail.com', port: 993, username: 'me@fastmail.example' });
    expect(settings.smtp).toMatchObject({ host: 'smtp.fastmail.com', port: 465, tls: 'tls', username: 'me@fastmail.example' });
    expect(connector.settings).toMatchObject({ smtpTls: 'tls', smtpPort: 465 });
  });

  it('custom: needs every server field, and takes an optional username for both logins', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const missing = await call('PUT', '/api/connectors/imap', { preset: 'custom', address: 'me@example.test', appPassword: 'pw' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain('imapHost');
    expect(getConnector(env.db, env.workspaceId, 'imap')).toBeNull();
    const ok = await call('PUT', '/api/connectors/imap', {
      preset: 'custom',
      address: 'me@example.test',
      username: 'login-name',
      appPassword: 'pw',
      imapHost: 'mail.example.test',
      imapPort: 1993,
      smtpHost: 'smtp.example.test',
      smtpPort: 2525,
      smtpTls: 'starttls',
    });
    expect(ok.status).toBe(201);
    const settings = stub.verifyCalls[0]!;
    expect(settings.imap).toMatchObject({ host: 'mail.example.test', port: 1993, username: 'login-name' });
    expect(settings.smtp).toMatchObject({ host: 'smtp.example.test', port: 2525, tls: 'starttls', username: 'login-name' });
    expect(ok.body.settings).toMatchObject({ preset: 'custom', imapHost: 'mail.example.test', imapPort: 1993, smtpHost: 'smtp.example.test', smtpPort: 2525, smtpTls: 'starttls' });
  });

  it('a preset refuses server fields, so a card cannot override what the preset fills', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const response = await call('PUT', '/api/connectors/imap', { preset: 'fastmail', address: stubImapAddress, appPassword: 'pw', imapHost: 'evil.example.test' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation');
    expect(stub.verifyCalls).toHaveLength(0);
  });
});

describe('connecting runs the verification and stores what was verified', () => {
  it('stores the flags, the detected Sent mailbox, the mailboxes, the capabilities, and the starting Inbox position', async () => {
    const env = freshEnv();
    stub.addInbound({ from: 'old@lanternrow.invalid', subject: 'Before connecting', text: 'x' });
    const { connector, created } = await connectImap(env);
    expect(created).toBe(true);
    expect(connector.status).toBe('connected');
    expect(connector.statusMessage).toBeNull();
    expect(connector.settings).toMatchObject({
      imapOk: true,
      smtpOk: true,
      sentMailbox: 'Sent',
      sentMailboxSource: 'detected',
      passwordSaved: true,
      lastSyncAt: null,
      capabilities: { imap: ['IMAP4rev1', 'UIDPLUS', 'SPECIAL-USE'], smtp: ['PIPELINING', '8BITMIME', 'STARTTLS'], smtpStoresSentCopy: null },
    });
    expect(connector.settings.mailboxes).toContainEqual({ path: 'Sent', specialUse: '\\Sent' });
    // The first poll starts where the Inbox stood at connect time.
    const stored = JSON.parse((env.db.prepare("SELECT settings FROM connector WHERE kind = 'imap'").get() as { settings: string }).settings);
    expect(stored.inboxCursor).toBe(`${stub.uidValidity}:1`);
  });

  it('stores the password as the secret and never returns it', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const put = await call('PUT', '/api/connectors/imap', { preset: 'fastmail', address: stubImapAddress, appPassword: stubImapPassword });
    const list = await call('GET', '/api/connectors');
    for (const text of [put.text, list.text, JSON.stringify(env.db.prepare('SELECT * FROM audit_event').all())]) {
      expect(text).not.toContain(stubImapPassword);
    }
    expect((env.db.prepare("SELECT secret FROM connector WHERE kind = 'imap'").get() as { secret: string }).secret).toBe(stubImapPassword);
    expect(list.body.items.find((item: any) => item.kind === 'imap').settings.passwordSaved).toBe(true);
  });

  it('serializes the documented settings shape', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/imap', { preset: 'icloud', address: stubImapAddress, appPassword: 'pw' });
    const row = (await call('GET', '/api/connectors')).body.items.find((item: any) => item.kind === 'imap');
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'kind', 'settings', 'status', 'statusMessage', 'updatedAt', 'workspaceId']);
    expect(Object.keys(row.settings).sort()).toEqual(
      [
        'address', 'capabilities', 'imapHost', 'imapOk', 'imapPort', 'lastSyncAt', 'lastSyncError', 'mailboxes', 'passwordSaved', 'preset', 'sentMailbox',
        'sentMailboxSource', 'smtpHost', 'smtpOk', 'smtpPort', 'smtpTls', 'smtpUsername', 'username', 'verifiedAt',
      ].sort(),
    );
  });

  it('first connect needs the password and stores nothing without it', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const response = await call('PUT', '/api/connectors/imap', { preset: 'fastmail', address: stubImapAddress });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('appPassword');
    expect(getConnector(env.db, env.workspaceId, 'imap')).toBeNull();
    expect(stub.verifyCalls).toHaveLength(0);
  });

  it.each([
    [{ preset: 'carrier-pigeon', address: stubImapAddress, appPassword: 'pw' }],
    [{ preset: 'fastmail', address: 'not an address', appPassword: 'pw' }],
    [{ preset: 'custom', address: stubImapAddress, appPassword: 'pw', imapHost: 'a.example.test', imapPort: '993', smtpHost: 'b.example.test', smtpPort: 465, smtpTls: 'tls' }],
    [{ preset: 'custom', address: stubImapAddress, appPassword: 'pw', imapHost: 'a.example.test', imapPort: 993, smtpHost: 'b.example.test', smtpPort: 465, smtpTls: 'plain' }],
    [{ preset: 'custom', address: stubImapAddress, appPassword: 'pw', imapHost: 'bad host', imapPort: 993, smtpHost: 'b.example.test', smtpPort: 465, smtpTls: 'tls' }],
    [{ preset: 'fastmail', address: stubImapAddress, appPassword: 'pw', surprise: 1 }],
  ])('refuses invalid input with a validation error: %j', async (body) => {
    const env = freshEnv();
    const call = await appFor(env);
    const response = await call('PUT', '/api/connectors/imap', body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation');
    expect(getConnector(env.db, env.workspaceId, 'imap')).toBeNull();
  });

  it('keeps the stored password, logins, and servers when a later request leaves them out', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/imap', { preset: 'icloud', address: stubImapAddress, appPassword: 'first-password' });
    const again = await call('PUT', '/api/connectors/imap', { preset: 'icloud', address: stubImapAddress, sentMailbox: 'Archive' });
    expect(again.status).toBe(200);
    const settings = stub.verifyCalls[1]!;
    expect(settings.imap.password).toBe('first-password');
    expect(settings.smtp.password).toBe('first-password');
    expect(settings.sentMailbox).toBe('Archive');
    expect(again.body.status).toBe('connected');
    expect(again.body.settings).toMatchObject({ sentMailbox: 'Archive', sentMailboxSource: 'chosen', imapHost: 'imap.mail.me.com', smtpPort: 587 });
    // Choosing again keeps the choice; clearing goes back to the detected mailbox.
    const kept = await call('PUT', '/api/connectors/imap', { preset: 'icloud', address: stubImapAddress });
    expect(kept.body.settings).toMatchObject({ sentMailbox: 'Archive', sentMailboxSource: 'chosen' });
    const cleared = await call('PUT', '/api/connectors/imap', { preset: 'icloud', address: stubImapAddress, sentMailbox: null });
    expect(cleared.body.settings).toMatchObject({ sentMailbox: 'Sent', sentMailboxSource: 'detected' });
    const replaced = await call('PUT', '/api/connectors/imap', { preset: 'icloud', address: stubImapAddress, appPassword: 'second-password' });
    expect(replaced.status).toBe(200);
    expect(stub.verifyCalls[stub.verifyCalls.length - 1]!.imap.password).toBe('second-password');
  });

  it('switching a preset refills the servers and logins', async () => {
    const env = freshEnv();
    await connectImap(env, { preset: 'icloud' });
    const { connector } = await connectImap(env, { preset: 'fastmail', appPassword: undefined });
    expect(connector.settings).toMatchObject({ preset: 'fastmail', imapHost: 'imap.fastmail.com', smtpTls: 'tls', username: stubImapAddress });
  });
});

describe('a failed verification is stored honestly, per step', () => {
  it('IMAP login failure on iCloud names the app specific password', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const response = await call('PUT', '/api/connectors/imap', { preset: 'icloud', address: stubImapAddress, appPassword: 'wrong-password-value' });
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('error');
    expect(response.body.statusMessage).toMatch(/^IMAP login failed\. iCloud Mail rejected the login at imap\.mail\.me\.com:993/);
    expect(response.body.statusMessage).toContain('account.apple.com');
    expect(response.body.statusMessage).toContain('App-Specific Passwords');
    expect(response.body.statusMessage).not.toContain('wrong-password-value');
    expect(response.body.settings).toMatchObject({ imapOk: false });
    expect(getConnector(env.db, env.workspaceId, 'imap')!.status).toBe('error');
  });

  it('IMAP login failure on Fastmail names the app password and the Basic plan', async () => {
    const env = freshEnv();
    const { connector } = await (async () => {
      const { configureImapConnector } = await import('../src/actions/index.js');
      return configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress, appPassword: 'wrong-one' });
    })();
    expect(connector.status).toBe('error');
    expect(connector.statusMessage).toMatch(/^IMAP login failed\. Fastmail rejected the login at imap\.fastmail\.com:993/);
    expect(connector.statusMessage).toContain('New app password');
    expect(connector.statusMessage).toContain('Basic plan');
  });

  it('SMTP failure says the IMAP login worked and which step failed', async () => {
    const env = freshEnv();
    const { configureImapConnector } = await import('../src/actions/index.js');
    const { connector } = await configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress, appPassword: 'smtp-wrong-pass' });
    expect(connector.status).toBe('error');
    expect(connector.statusMessage).toMatch(/^SMTP login failed\. The IMAP login worked, but Fastmail rejected the SMTP login at smtp\.fastmail\.com:465/);
    expect(connector.settings).toMatchObject({ imapOk: true, smtpOk: false });
  });

  it('keeps the stored app password when a new one fails the checks, and says so', async () => {
    const env = freshEnv();
    const { connectImap } = await import('./mailHelpers.js');
    const { configureImapConnector } = await import('../src/actions/index.js');
    await connectImap(env);
    const before = (env.db.prepare("SELECT secret FROM connector WHERE kind = 'imap'").get() as { secret: string }).secret;

    const failed = await configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress, appPassword: 'wrong-new-pass' });
    expect(failed.connector.status).toBe('error');
    expect(failed.connector.statusMessage).toContain('The new app password was not kept; the previous one is still used.');
    const after = (env.db.prepare("SELECT secret FROM connector WHERE kind = 'imap'").get() as { secret: string }).secret;
    expect(after).toBe(before);
    expect(after).not.toContain('wrong-new-pass');

    // The kept password still works, so a plain re-save recovers the connector without retyping anything.
    const recovered = await configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress });
    expect(recovered.connector.status).toBe('connected');
  });

  it('keeps a working connector connected when a chosen Sent mailbox does not exist', async () => {
    const env = freshEnv();
    const { connectImap } = await import('./mailHelpers.js');
    const { configureImapConnector } = await import('../src/actions/index.js');
    await connectImap(env);

    const { connector } = await configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress, sentMailbox: 'Sentt' });
    expect(connector.status).toBe('connected');
    expect(connector.statusMessage).toContain('does not exist on the server, so the Sent mailbox was not changed');
    expect(connector.settings).toMatchObject({ sentMailbox: 'Sent' });
  });

  it('a network failure says it could not reach the server rather than blaming the password', async () => {
    const env = freshEnv();
    stub.knobs.imapLoginFailure = 'connect ECONNREFUSED';
    const { configureImapConnector } = await import('../src/actions/index.js');
    const failure = await configureImapConnector(env.ctx, { preset: 'custom', address: stubImapAddress, appPassword: 'pw', imapHost: 'mail.example.test', imapPort: 993, smtpHost: 'smtp.example.test', smtpPort: 465, smtpTls: 'tls' });
    // The stub reports every IMAP failure as a login failure. The sentence still names the step.
    expect(failure.connector.statusMessage).toMatch(/^IMAP login failed\./);
    expect(failure.connector.statusMessage).toContain('mail.example.test:993');
  });

  it('no Sent mailbox found is its own sentence, and a chosen mailbox must exist', async () => {
    const env = freshEnv();
    stub.knobs.noSentMailbox = true;
    const { configureImapConnector } = await import('../src/actions/index.js');
    const none = await configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress, appPassword: 'pw' });
    expect(none.connector.status).toBe('error');
    expect(none.connector.statusMessage).toMatch(/^No Sent mailbox found\. The server does not mark any mailbox as Sent/);
    expect(none.connector.settings).toMatchObject({ imapOk: true, smtpOk: true, sentMailbox: null });
    // Choosing one fixes it.
    const chosen = await configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress, sentMailbox: 'Archive' });
    expect(chosen.connector.status).toBe('connected');
    expect(chosen.connector.settings).toMatchObject({ sentMailbox: 'Archive', sentMailboxSource: 'chosen' });
    // A wrong choice afterwards never wrecks the working connector: the old mailbox is kept, with a sentence.
    const wrong = await configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress, sentMailbox: 'Nope' });
    expect(wrong.connector.status).toBe('connected');
    expect(wrong.connector.statusMessage).toContain('The mailbox "Nope" does not exist on the server, so the Sent mailbox was not changed');
    expect(wrong.connector.settings).toMatchObject({ sentMailbox: 'Archive' });
    // On a first connect there is nothing to keep, so a wrong choice is a real error.
    const env2 = freshEnv();
    stub.knobs.noSentMailbox = true;
    const first = await configureImapConnector(env2.ctx, { preset: 'fastmail', address: stubImapAddress, appPassword: 'pw', sentMailbox: 'Nope' });
    expect(first.connector.status).toBe('error');
    expect(first.connector.statusMessage).toContain('The mailbox "Nope" does not exist on the server');
  });

  it('an unexpected failure of the check itself is stored as an error', async () => {
    const env = freshEnv();
    stub.verify = async () => {
      throw new Error('Something broke with token app-secret-pass');
    };
    const { configureImapConnector } = await import('../src/actions/index.js');
    let connector;
    try {
      ({ connector } = await configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress, appPassword: 'app-secret-pass' }));
    } finally {
      delete (stub as unknown as { verify?: unknown }).verify;
    }
    expect(connector.status).toBe('error');
    expect(connector.statusMessage).toContain('IMAP login failed');
    expect(connector.statusMessage).not.toContain('app-secret-pass');
  });

  it('recovers when the next check passes, clearing the sentence', async () => {
    const env = freshEnv();
    const { configureImapConnector } = await import('../src/actions/index.js');
    await configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress, appPassword: 'wrong-pass' });
    const { connector, created } = await configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress, appPassword: stubImapPassword });
    expect(created).toBe(false);
    expect(connector).toMatchObject({ status: 'connected', statusMessage: null });
    expect(connector.settings).toMatchObject({ imapOk: true, smtpOk: true });
  });
});

describe('the mail provider in use', () => {
  it('is set by the first connector that is ready, and an unverified one is not ready', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    stub.knobs.noSentMailbox = true;
    await call('PUT', '/api/connectors/imap', { preset: 'fastmail', address: stubImapAddress, appPassword: 'pw' });
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'imap', ready: false });
    const refused = await call('POST', '/api/mail-provider', { kind: 'imap' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('needs attention');
    stub.knobs.noSentMailbox = false;
    await call('PUT', '/api/connectors/imap', { preset: 'fastmail', address: stubImapAddress });
    expect((await call('GET', '/api/mail-provider')).body).toEqual({ kind: 'imap', address: stubImapAddress, ready: true, lastSyncAt: null });
    const settings = JSON.parse((env.db.prepare('SELECT settings FROM workspace').get() as { settings: string }).settings);
    expect(settings.mailProvider).toBe('imap');
  });

  it('is not ready without both verified flags, even when connected', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectImap(env);
    for (const flag of ['imapOk', 'smtpOk']) {
      const row = env.db.prepare("SELECT id, settings FROM connector WHERE kind = 'imap'").get() as { id: string; settings: string };
      const original = row.settings;
      env.db.prepare('UPDATE connector SET settings = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(original), [flag]: false }), row.id);
      expect((await call('GET', '/api/mail-provider')).body.ready).toBe(false);
      env.db.prepare('UPDATE connector SET settings = ? WHERE id = ?').run(original, row.id);
      expect((await call('GET', '/api/mail-provider')).body.ready).toBe(true);
    }
  });

  it('never steals sending from the provider already in use, and switches on request', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMail(env);
    await connectImap(env);
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'agentmail', ready: true });
    const switched = await call('POST', '/api/mail-provider', { kind: 'imap' });
    expect(switched.status).toBe(200);
    expect(switched.body).toEqual({ kind: 'imap', address: stubImapAddress, ready: true, lastSyncAt: null });
    expect((await call('PUT', '/api/mail-provider', { kind: 'agentmail' })).body.kind).toBe('agentmail');
  });

  it('switching away blocks messages queued for IMAP, and nothing leaves from either account', async () => {
    const env = freshEnv();
    await connectImap(env);
    await connectMail(env);
    const queued = queueOne(env, 'Ann', 'ann@lanternrow.invalid');
    setMailProvider(env.ctx, { kind: 'agentmail' });
    expect(intentOf(env, queued)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    await drain(env);
    expect(stub.sendCalls).toHaveLength(0);
    expect(agentmail.state.sendAttempts).toHaveLength(0);
  });

  it('keeps reconciling an unknown IMAP intent with IMAP after a switch', async () => {
    const env = freshEnv();
    await connectImap(env);
    await connectMail(env);
    stub.knobs.sentAutoSave = true;
    stub.sendScript.push({ type: 'ambiguous', accepted: true });
    const unknown = queueOne(env, 'Bea', 'bea@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, unknown)).toBe('unknown');
    setMailProvider(env.ctx, { kind: 'agentmail' });
    env.advance(1500);
    await drain(env);
    expect(statusOf(env, unknown)).toBe('accepted');
    expect(stub.sendCalls).toHaveLength(1);
    expect(agentmail.state.sendAttempts).toHaveLength(0);
  });

  it('shows the provider on send intent rows', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectImap(env);
    queueOne(env, 'Cid', 'cid@lanternrow.invalid');
    const rows = (await call('GET', '/api/send-intents')).body.items;
    expect(rows[0]).toMatchObject({ provider: 'imap', inboxId: stubImapAddress });
    expect((await call('GET', '/api/mail/summary')).body.provider).toBe('imap');
  });
});

describe('changing the address', () => {
  it('blocks messages approved to leave from the old address and starts the Inbox position again', async () => {
    const env = freshEnv();
    await connectImap(env);
    const queued = queueOne(env, 'Dot', 'dot@lanternrow.invalid');
    stub.addInbound({ from: 'x@lanternrow.invalid', subject: 's', text: 't' });
    await connectImap(env, { address: 'other@imap-stub.invalid', appPassword: undefined });
    expect(intentOf(env, queued)).toMatchObject({ status: 'blocked', error: 'The sending inbox changed after this message was approved.' });
    const stored = JSON.parse((env.db.prepare("SELECT settings FROM connector WHERE kind = 'imap'").get() as { settings: string }).settings);
    expect(stored.inboxCursor).toBe(`${stub.uidValidity}:${stub.uidNext - 1}`);
  });
});

describe('removing the connector', () => {
  it('blocks queued and approved mail, keeps submitting and unknown intents with the reason added, and deletes the row', async () => {
    const env = freshEnv();
    await connectImap(env);
    const queued = queueOne(env, 'Yul', 'yul@lanternrow.invalid');
    const approved = queueOne(env, 'Zed', 'zed@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'approved' WHERE id = ?").run(approved);
    const submitting = queueOne(env, 'Abby', 'abby@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'submitting' WHERE id = ?").run(submitting);
    const unknown = queueOne(env, 'Bram', 'bram@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'unknown', error = 'Outcome unknown.' WHERE id = ?").run(unknown);

    const call = await appFor(env);
    const response = await call('DELETE', '/api/connectors/imap');
    expect(response.status).toBe(204);
    expect(getConnector(env.db, env.workspaceId, 'imap')).toBeNull();
    expect(intentOf(env, queued)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    expect(intentOf(env, approved)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    expect(intentOf(env, submitting)).toMatchObject({ status: 'submitting', error: 'connector_removed' });
    expect(intentOf(env, unknown)).toMatchObject({ status: 'unknown', error: 'Outcome unknown. connector_removed' });
    // This provider never resends, so there is no resend marker to set.
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM send_intent WHERE no_resend = 1').get()).toEqual({ n: 0 });
    await drain(env);
    expect(stub.sendCalls).toHaveLength(0);
    expect((await call('GET', '/api/mail-provider')).body).toBeNull();
    expect((await call('DELETE', '/api/connectors/imap')).status).toBe(404);
  });

  it('leaves the other provider and its queued mail alone, and moves the choice to it', async () => {
    const env = freshEnv();
    await connectImap(env);
    await connectMail(env);
    const call = await appFor(env);
    expect((await call('GET', '/api/mail-provider')).body.kind).toBe('imap');
    disconnectImapConnector(env.ctx);
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'agentmail', ready: true });
  });
});
