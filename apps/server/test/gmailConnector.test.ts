import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configureAgentmailConnector, configureGmailConnector, disconnectGmailConnector, markGmailError, setMailProvider } from '../src/actions/index.js';
import { hashPayload } from '../src/actions/demoResearch.js';
import { buildApp } from '../src/http/app.js';
import { processMailJobs } from '../src/jobs/worker.js';
import { getConnector } from '../src/queries/connectors.js';
import { type AgentmailStub, startAgentmailStub, stubAgentmailKey, useAgentmailStub } from './agentmailStub.js';
import { type GoogleStub, startGoogleStub, stubGmailAddress, stubGoogleClientId, stubGoogleClientSecret, useGoogleStub } from './googleStub.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { addDraft, addPerson, approve, connectGmail, connectMail, drain, intentOf, queueOne, stage, statusOf } from './mailHelpers.js';

let google: GoogleStub;
let agentmail: AgentmailStub;
let restoreGoogle: () => void;
let restoreAgentmail: () => void;
const environments: TestEnvironment[] = [];
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  google = await startGoogleStub();
  agentmail = await startAgentmailStub();
  restoreGoogle = useGoogleStub(google);
  restoreAgentmail = useAgentmailStub(agentmail);
});

afterEach(() => {
  google.reset();
  agentmail.reset();
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await google.close();
  await agentmail.close();
  restoreGoogle();
  restoreAgentmail();
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
  const call = async (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.inject({ method, url, payload: payload as object | undefined, headers: { host: '127.0.0.1:4720', ...headers } });
    return {
      status: response.statusCode,
      text: response.body,
      location: response.headers.location as string | undefined,
      body: response.body && response.headers['content-type']?.toString().includes('json') ? (JSON.parse(response.body) as any) : null,
    };
  };
  return call;
}

function callbackPathFor(approvedUrl: string): string {
  const url = new URL(approvedUrl);
  return `${url.pathname}${url.search}`;
}

function auditCount(env: TestEnvironment): number {
  return (env.db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }).n;
}

const credentials = { clientId: stubGoogleClientId, clientSecret: stubGoogleClientSecret };

describe('saving the Google client', () => {
  it('validates only the shape of the credentials and makes no network call', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    expect((await call('PUT', '/api/connectors/gmail', {})).status).toBe(400);
    expect((await call('PUT', '/api/connectors/gmail', { clientId: 'has space' })).status).toBe(400);
    expect((await call('PUT', '/api/connectors/gmail', { clientId: 'abc.apps.googleusercontent.com' })).status).toBe(400);
    expect((await call('PUT', '/api/connectors/gmail', { ...credentials, extra: 1 })).status).toBe(400);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM connector').get()).toEqual({ n: 0 });

    const created = await call('PUT', '/api/connectors/gmail', credentials);
    expect(created.status).toBe(201);
    expect(google.state.requests).toHaveLength(0);
    expect(created.body).toMatchObject({
      kind: 'gmail',
      status: 'connected',
      statusMessage: null,
      clientSecretMasked: '****9876',
      settings: { clientId: stubGoogleClientId, emailAddress: null, address: null, signedIn: false, oauthPending: false, lastSyncAt: null },
    });
    expect(created.text).not.toContain(stubGoogleClientSecret);
    const again = await call('PUT', '/api/connectors/gmail', { clientSecret: 'GOCSPX-replacement0001' });
    expect(again.status).toBe(200);
    expect(again.body.clientSecretMasked).toBe('****0001');
    expect(again.body.settings.clientId).toBe(stubGoogleClientId);
  });

  it('lists the connector without any secret, token, state, or verifier', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    const start = await call('POST', '/api/connectors/gmail/oauth/start');
    const listing = await call('GET', '/api/connectors');
    const gmail = listing.body.items.find((item: { kind: string }) => item.kind === 'gmail');
    expect(gmail.settings.oauthPending).toBe(true);
    const url = new URL(start.body.url);
    expect(listing.text).not.toContain(stubGoogleClientSecret);
    expect(listing.text).not.toContain(url.searchParams.get('state'));
    expect(listing.text).not.toContain('verifier');
    expect(Object.keys(gmail).sort()).toEqual(['clientSecretMasked', 'createdAt', 'id', 'kind', 'settings', 'status', 'statusMessage', 'updatedAt', 'workspaceId']);
  });

  it('needs saved credentials before a sign in can start', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const refused = await call('POST', '/api/connectors/gmail/oauth/start');
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('client id');
  });
});

describe('the sign in flow', () => {
  it('runs start, consent, and callback, then stores tokens, the address, and the cursor and redirects with 303', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    const start = await call('POST', '/api/connectors/gmail/oauth/start');
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${google.url}/o/oauth2/v2/auth`);
    expect(Object.fromEntries(url.searchParams.entries())).toMatchObject({
      client_id: stubGoogleClientId,
      redirect_uri: 'http://127.0.0.1:4720/api/connectors/gmail/oauth/callback',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('state')!.length).toBeGreaterThan(20);
    expect(url.searchParams.get('code_challenge')!.length).toBeGreaterThan(20);
    const baseline = getConnector(env.db, env.workspaceId, 'gmail')!.updatedAt;

    const callback = await call('GET', callbackPathFor(google.approve(start.body.url)));
    expect(callback.status).toBe(303);
    expect(callback.location).toBe('/settings/connectors');
    const exchange = google.state.tokenRequests.find((request) => request.grantType === 'authorization_code')!;
    expect(exchange.verifierMatched).toBe(true);
    expect(exchange.form.redirect_uri).toBe('http://127.0.0.1:4720/api/connectors/gmail/oauth/callback');

    const connector = getConnector(env.db, env.workspaceId, 'gmail')!;
    expect(connector.updatedAt > baseline).toBe(true);
    expect(connector.status).toBe('connected');
    expect(connector.settings).toMatchObject({ emailAddress: stubGmailAddress, address: stubGmailAddress, signedIn: true, oauthPending: false });
    const stored = JSON.parse((env.db.prepare("SELECT settings, secret FROM connector WHERE kind = 'gmail'").get() as { secret: string }).secret);
    expect(stored.refreshToken).toMatch(/^1\/\/stub-refresh/);
    expect(stored.accessToken).toMatch(/^ya29\./);
    const settings = JSON.parse((env.db.prepare("SELECT settings FROM connector WHERE kind = 'gmail'").get() as { settings: string }).settings);
    expect(settings.historyId).toBe(String(google.state.historyId));
    expect(settings.pending).toBeUndefined();

    const listing = await call('GET', '/api/connectors');
    expect(listing.text).not.toContain(stored.refreshToken);
    expect(listing.text).not.toContain(stored.accessToken);
    expect((await call('GET', '/api/mail-provider')).body).toEqual({ kind: 'gmail', address: stubGmailAddress, ready: true, lastSyncAt: null });
  });

  it('sends the browser back to the page that started the sign in when it is a loopback origin', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    const start = await call('POST', '/api/connectors/gmail/oauth/start', undefined, { origin: 'http://127.0.0.1:5173' });
    const callback = await call('GET', callbackPathFor(google.approve(start.body.url)));
    expect(callback.location).toBe('http://127.0.0.1:5173/settings/connectors');

    const other = await call('POST', '/api/connectors/gmail/oauth/start', undefined, { origin: 'https://evil.example.org' });
    const second = await call('GET', callbackPathFor(google.approve(other.body.url)));
    expect(second.location).toBe('/settings/connectors');
  });

  it('refuses a callback whose state does not match, records nothing, and keeps the sign in under way', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    const start = await call('POST', '/api/connectors/gmail/oauth/start');
    const baseline = getConnector(env.db, env.workspaceId, 'gmail')!.updatedAt;
    const auditBefore = auditCount(env);
    const approved = new URL(google.approve(start.body.url));
    approved.searchParams.set('state', 'forged-state');
    const refused = await call('GET', callbackPathFor(approved.toString()));
    expect(refused.status).toBe(303);
    expect(refused.location).toBe('/settings/connectors?gmail_error=state_mismatch');
    expect(google.state.tokenRequests).toHaveLength(0);
    const connector = getConnector(env.db, env.workspaceId, 'gmail')!;
    expect(connector.settings.signedIn).toBe(false);
    // A stray callback cannot write a sentence, move updated_at, or leave an audit row.
    expect(connector.statusMessage).toBeNull();
    expect(connector.updatedAt).toBe(baseline);
    expect(connector.status).toBe('connected');
    expect(auditCount(env)).toBe(auditBefore);
    expect(connector.settings.oauthPending).toBe(true);
    // A forged callback does not cancel the real one.
    const good = await call('GET', callbackPathFor(google.approve(start.body.url)));
    expect(good.location).toBe('/settings/connectors');
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.settings.signedIn).toBe(true);
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.statusMessage).toBeNull();
  });

  it('records nothing for a callback when no sign in is pending', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    const baseline = getConnector(env.db, env.workspaceId, 'gmail')!.updatedAt;
    const auditBefore = auditCount(env);
    for (const query of ['?code=abc&state=anything', '?state=', '?error=access_denied&state=x', '']) {
      const refused = await call('GET', `/api/connectors/gmail/oauth/callback${query}`);
      expect(refused.status).toBe(303);
      expect(refused.location).toBe('/settings/connectors?gmail_error=state_mismatch');
    }
    const connector = getConnector(env.db, env.workspaceId, 'gmail')!;
    expect(connector.statusMessage).toBeNull();
    expect(connector.updatedAt).toBe(baseline);
    expect(connector.settings.oauthCompletedAt).toBeNull();
    expect(auditCount(env)).toBe(auditBefore);
    expect(google.state.tokenRequests).toHaveLength(0);
  });

  it('sets oauthCompletedAt only when a sign in finishes, and a failed attempt moves updatedAt without it', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.settings.oauthCompletedAt).toBeNull();

    const cancelled = await call('POST', '/api/connectors/gmail/oauth/start');
    const beforeFailure = getConnector(env.db, env.workspaceId, 'gmail')!;
    await call('GET', callbackPathFor(google.approve(cancelled.body.url, 'deny')));
    const afterFailure = getConnector(env.db, env.workspaceId, 'gmail')!;
    expect(afterFailure.updatedAt > beforeFailure.updatedAt).toBe(true);
    expect(afterFailure.statusMessage).toContain('cancelled');
    expect(afterFailure.settings.oauthCompletedAt).toBeNull();

    const start = await call('POST', '/api/connectors/gmail/oauth/start');
    await call('GET', callbackPathFor(google.approve(start.body.url)));
    const afterSuccess = getConnector(env.db, env.workspaceId, 'gmail')!;
    expect(afterSuccess.settings.signedIn).toBe(true);
    expect(afterSuccess.settings.oauthCompletedAt).not.toBeNull();
    expect(afterSuccess.statusMessage).toBeNull();
    const completed = afterSuccess.settings.oauthCompletedAt;

    // A later failure bumps updatedAt, writes its sentence, and leaves the completion time alone.
    const again = await call('POST', '/api/connectors/gmail/oauth/start');
    await call('GET', callbackPathFor(google.approve(again.body.url, 'deny')));
    const afterSecondFailure = getConnector(env.db, env.workspaceId, 'gmail')!;
    expect(afterSecondFailure.settings.oauthCompletedAt).toBe(completed);
    expect(afterSecondFailure.updatedAt > afterSuccess.updatedAt).toBe(true);
    expect(afterSecondFailure.statusMessage).toContain('cancelled');

    const third = await call('POST', '/api/connectors/gmail/oauth/start');
    await call('GET', callbackPathFor(google.approve(third.body.url)));
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.settings.oauthCompletedAt! > completed!).toBe(true);
  });

  it('refuses a callback with no state, and a replayed callback', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    expect((await call('GET', '/api/connectors/gmail/oauth/callback?code=abc')).location).toBe('/settings/connectors?gmail_error=state_mismatch');
    const start = await call('POST', '/api/connectors/gmail/oauth/start');
    const path = callbackPathFor(google.approve(start.body.url));
    expect((await call('GET', path)).location).toBe('/settings/connectors');
    expect((await call('GET', path)).location).toBe('/settings/connectors?gmail_error=state_mismatch');
    expect(google.state.tokenRequests.filter((request) => request.grantType === 'authorization_code')).toHaveLength(1);
  });

  it('refuses a sign in that took more than fifteen minutes', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    const start = await call('POST', '/api/connectors/gmail/oauth/start');
    env.advance(16 * 60 * 1000);
    const refused = await call('GET', callbackPathFor(google.approve(start.body.url)));
    expect(refused.location).toBe('/settings/connectors?gmail_error=expired');
    expect(google.state.tokenRequests).toHaveLength(0);
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.settings.signedIn).toBe(false);
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.statusMessage).toContain('15 minutes');
  });

  it('accepts a sign in just inside the fifteen minutes', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    const start = await call('POST', '/api/connectors/gmail/oauth/start');
    env.advance(14 * 60 * 1000);
    expect((await call('GET', callbackPathFor(google.approve(start.body.url)))).location).toBe('/settings/connectors');
  });

  it('reports a cancelled consent with its own code', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    const start = await call('POST', '/api/connectors/gmail/oauth/start');
    const denied = await call('GET', callbackPathFor(google.approve(start.body.url, 'deny')));
    expect(denied.location).toBe('/settings/connectors?gmail_error=access_denied');
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.statusMessage).toContain('cancelled');
  });

  it('refuses a sign in when a permission was left unticked', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    google.state.grantedScopes = ['https://www.googleapis.com/auth/gmail.send'];
    const start = await call('POST', '/api/connectors/gmail/oauth/start');
    const refused = await call('GET', callbackPathFor(google.approve(start.body.url)));
    expect(refused.location).toBe('/settings/connectors?gmail_error=missing_permissions');
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.settings.signedIn).toBe(false);
  });

  it('reports an exchange failure with a short code and the detail on the connector', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    const start = await call('POST', '/api/connectors/gmail/oauth/start');
    const path = callbackPathFor(google.approve(start.body.url));
    google.state.tokenMode = 'invalid_client';
    const failed = await call('GET', path);
    expect(failed.location).toBe('/settings/connectors?gmail_error=exchange_failed');
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.statusMessage).toContain('client');
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.settings.signedIn).toBe(false);
  });

  it('redirects with a code and stores nothing when there is no saved client', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const refused = await call('GET', '/api/connectors/gmail/oauth/callback?code=x&state=y');
    expect(refused.status).toBe(303);
    expect(refused.location).toBe('/settings/connectors?gmail_error=no_connector');
  });

  it('signing in again as the same account keeps the saved position, and a different account blocks queued mail', async () => {
    const env = freshEnv();
    await connectGmail(env, google);
    const queued = queueOne(env, 'Ona', 'ona@lanternrow.invalid');
    const settingsBefore = JSON.parse((env.db.prepare("SELECT settings FROM connector WHERE kind = 'gmail'").get() as { settings: string }).settings);
    google.state.historyId += 50;
    await connectGmail(env, google);
    const settingsSame = JSON.parse((env.db.prepare("SELECT settings FROM connector WHERE kind = 'gmail'").get() as { settings: string }).settings);
    expect(settingsSame.historyId).toBe(settingsBefore.historyId);
    expect(statusOf(env, queued)).toBe('queued');

    google.state.address = 'another@gmail-stub.invalid';
    await connectGmail(env, google);
    expect(intentOf(env, queued)).toMatchObject({ status: 'blocked' });
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.settings.address).toBe('another@gmail-stub.invalid');
  });
});

describe('the mail provider in use', () => {
  it('is null before any mail connector, then set by the first one that is ready', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    expect((await call('GET', '/api/mail-provider')).body).toBeNull();
    await call('PUT', '/api/connectors/gmail', credentials);
    // Credentials alone are not a sending address.
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'gmail', address: null, ready: false });
    const start = await call('POST', '/api/connectors/gmail/oauth/start');
    await call('GET', callbackPathFor(google.approve(start.body.url)));
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'gmail', address: stubGmailAddress, ready: true });
    const settings = JSON.parse((env.db.prepare('SELECT settings FROM workspace').get() as { settings: string }).settings);
    expect(settings.mailProvider).toBe('gmail');
  });

  it('keeps the first provider when a second connects, and switches on request', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMail(env);
    await connectGmail(env, google);
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'agentmail', ready: true });
    const switched = await call('POST', '/api/mail-provider', { kind: 'gmail' });
    expect(switched.status).toBe(200);
    expect(switched.body).toEqual({ kind: 'gmail', address: stubGmailAddress, ready: true, lastSyncAt: null });
    expect((await call('GET', '/api/mail-provider')).body.kind).toBe('gmail');
  });

  it('validates the switch', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    expect((await call('POST', '/api/mail-provider', { kind: 'carrier-pigeon' })).status).toBe(400);
    expect((await call('POST', '/api/mail-provider', {})).status).toBe(400);
    const notConnected = await call('POST', '/api/mail-provider', { kind: 'gmail' });
    expect(notConnected.status).toBe(409);
    expect(notConnected.body.error.message).toContain('Gmail is not connected');
  });

  it('stages under the provider in use: the preflight reads that connector address', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectGmail(env, google);
    const person = addPerson(env, 'Pat', 'pat@lanternrow.invalid');
    const viaAgentmail = stage(env, [addDraft(env, person.id, 'One', 'Body one')]);
    expect(viaAgentmail.intents[0]).toMatchObject({ provider: 'agentmail', inboxId: 'crm@stub-mail.invalid' });
    expect((viaAgentmail.approval!.payload as any).inboxEmail).toBe('crm@stub-mail.invalid');

    setMailProvider(env.ctx, { kind: 'gmail' });
    const person2 = addPerson(env, 'Quin', 'quin@lanternrow.invalid');
    const viaGmail = stage(env, [addDraft(env, person2.id, 'Two', 'Body two')]);
    expect(viaGmail.intents[0]).toMatchObject({ provider: 'gmail', inboxId: stubGmailAddress });
    expect((viaGmail.approval!.payload as any).inboxEmail).toBe(stubGmailAddress);
    expect((viaGmail.approval!.payload as any).mailProvider).toBe('gmail');
  });

  it('excludes everything with no_inbox when the provider in use has no sending address', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    const person = addPerson(env, 'Rex', 'rex@lanternrow.invalid');
    const staged = stage(env, [addDraft(env, person.id, 'Hi', 'Body')]);
    expect(staged.approval).toBeNull();
    expect(staged.excluded[0]!.reason).toBe('no_inbox');
  });

  it('blocks messages queued for the provider that was switched away from, and sends nothing from either', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectGmail(env, google);
    const viaAgentmail = queueOne(env, 'Sam', 'sam@lanternrow.invalid');
    expect(statusOf(env, viaAgentmail)).toBe('queued');
    setMailProvider(env.ctx, { kind: 'gmail' });
    expect(intentOf(env, viaAgentmail)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    const viaGmail = queueOne(env, 'Tess', 'tess@lanternrow.invalid');
    expect(intentOf(env, viaGmail).provider).toBe('gmail');
    setMailProvider(env.ctx, { kind: 'agentmail' });
    expect(intentOf(env, viaGmail)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    await drain(env);
    expect(agentmail.state.sendAttempts).toHaveLength(0);
    expect(google.state.sendAttempts).toHaveLength(0);
  });

  it('re-checks the provider at submit, so a switch that bypassed the action still cannot send', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectGmail(env, google);
    const queued = queueOne(env, 'Ula', 'ula@lanternrow.invalid');
    env.db.prepare("UPDATE workspace SET settings = json_set(COALESCE(settings, '{}'), '$.mailProvider', 'gmail') WHERE id = ?").run(env.workspaceId);
    await drain(env);
    expect(intentOf(env, queued)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    expect(agentmail.state.sendAttempts).toHaveLength(0);
  });

  it('refuses to approve messages staged for a provider that is no longer in use', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectGmail(env, google);
    const person = addPerson(env, 'Vic', 'vic@lanternrow.invalid');
    const staged = stage(env, [addDraft(env, person.id, 'Hi', 'Body')]);
    setMailProvider(env.ctx, { kind: 'gmail' });
    expect(() => approve(env, staged.approval!.id)).toThrowError(/sending connector changed/);
    expect(statusOf(env, staged.intents[0]!.id)).toBe('awaiting_approval');
  });

  it('keeps reconciling an unknown intent with the provider that staged it after a switch', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectGmail(env, google);
    setMailProvider(env.ctx, { kind: 'gmail' });
    google.state.sendScript.push({ type: 'process_then_respond', status: 502 });
    const unknown = queueOne(env, 'Wil', 'wil@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, unknown)).toBe('unknown');
    setMailProvider(env.ctx, { kind: 'agentmail' });
    expect(statusOf(env, unknown)).toBe('unknown');
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, unknown)).toBe('accepted');
    expect(agentmail.state.sendAttempts).toHaveLength(0);
    expect(google.state.sent).toHaveLength(1);
  });

  it('shows the provider on send intent rows and the mail summary', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectGmail(env, google);
    queueOne(env, 'Xan', 'xan@lanternrow.invalid');
    const rows = await call('GET', '/api/send-intents');
    expect(rows.body.items[0]).toMatchObject({ provider: 'gmail', inboxId: stubGmailAddress, status: 'queued' });
    const summary = await call('GET', '/api/mail/summary');
    expect(summary.body).toMatchObject({ provider: 'gmail', inbox: { connected: true, inboxEmail: stubGmailAddress } });
    const approvals = await call('GET', '/api/approvals');
    expect(approvals.body.items[0].payload.mailProvider).toBe('gmail');
  });
});

describe('removing the connector', () => {
  it('blocks queued and approved mail, keeps submitting and unknown intents with the reason added, and deletes the row', async () => {
    const env = freshEnv();
    await connectGmail(env, google);
    const queued = queueOne(env, 'Yul', 'yul@lanternrow.invalid');
    const approved = queueOne(env, 'Zed', 'zed@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'approved' WHERE id = ?").run(approved);
    const submitting = queueOne(env, 'Abby', 'abby@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'submitting' WHERE id = ?").run(submitting);
    const unknown = queueOne(env, 'Bram', 'bram@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'unknown', error = 'Outcome unknown.' WHERE id = ?").run(unknown);

    disconnectGmailConnector(env.ctx);
    expect(getConnector(env.db, env.workspaceId, 'gmail')).toBeNull();
    expect(intentOf(env, queued)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    expect(intentOf(env, approved)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    expect(intentOf(env, submitting)).toMatchObject({ status: 'submitting', error: 'connector_removed' });
    expect(intentOf(env, unknown)).toMatchObject({ status: 'unknown', error: 'Outcome unknown. connector_removed' });
    await drain(env);
    expect(google.state.sendAttempts).toHaveLength(0);
    expect(env.db.prepare('SELECT settings FROM workspace').get()).toMatchObject({});
    const call = await appFor(env);
    expect((await call('GET', '/api/mail-provider')).body).toBeNull();
  });

  it('leaves the other provider and its queued mail alone, and moves the choice to it', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMail(env);
    await connectGmail(env, google);
    setMailProvider(env.ctx, { kind: 'gmail' });
    const viaGmail = queueOne(env, 'Cato', 'cato@lanternrow.invalid');
    setMailProvider(env.ctx, { kind: 'agentmail' });
    const viaAgentmail = queueOne(env, 'Dara', 'dara@lanternrow.invalid');
    setMailProvider(env.ctx, { kind: 'gmail' });
    expect(statusOf(env, viaAgentmail)).toBe('blocked');
    const gone = await call('DELETE', '/api/connectors/gmail');
    expect(gone.status).toBe(204);
    expect(statusOf(env, viaGmail)).toBe('blocked');
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'agentmail', ready: true });
    expect(getConnector(env.db, env.workspaceId, 'agentmail')).not.toBeNull();
    expect((await call('DELETE', '/api/connectors/gmail')).status).toBe(404);
  });

  it('removing the other provider does not touch Gmail intents', async () => {
    const env = freshEnv();
    const { disconnectAgentmailConnector } = await import('../src/actions/index.js');
    await connectMail(env);
    await connectGmail(env, google);
    setMailProvider(env.ctx, { kind: 'gmail' });
    const viaGmail = queueOne(env, 'Eli', 'eli@lanternrow.invalid');
    disconnectAgentmailConnector(env.ctx);
    expect(statusOf(env, viaGmail)).toBe('queued');
    await drain(env);
    expect(statusOf(env, viaGmail)).toBe('accepted');
  });
});

describe('changing the client', () => {
  it('signs the account out when the client id changes, and blocks mail approved to leave from it', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectGmail(env, google);
    const queued = queueOne(env, 'Fay', 'fay@lanternrow.invalid');
    const changed = await call('PUT', '/api/connectors/gmail', { clientId: 'other-client.apps.googleusercontent.com', clientSecret: 'GOCSPX-newsecret0002' });
    expect(changed.status).toBe(200);
    expect(changed.body.settings).toMatchObject({ clientId: 'other-client.apps.googleusercontent.com', signedIn: false, emailAddress: null });
    expect(statusOf(env, queued)).toBe('blocked');
    await drain(env);
    expect(google.state.sendAttempts).toHaveLength(0);
  });

  it('keeps the sign in when only the secret changes', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectGmail(env, google);
    const changed = await call('PUT', '/api/connectors/gmail', { clientSecret: 'GOCSPX-rotated0003' });
    expect(changed.body.settings.signedIn).toBe(true);
  });
});

function storedChoice(env: TestEnvironment): string | undefined {
  const row = env.db.prepare('SELECT settings FROM workspace').get() as { settings: string };
  return (JSON.parse(row.settings) as { mailProvider?: string }).mailProvider;
}

function forgetChoice(env: TestEnvironment): void {
  env.db.prepare("UPDATE workspace SET settings = json_remove(settings, '$.mailProvider')").run();
}

describe('connecting a second provider never moves sending', () => {
  it('stores the provider already sending before Gmail signs in, so the queued AgentMail message stays put', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMail(env);
    // A workspace that predates the stored choice: AgentMail sends through the fallback.
    forgetChoice(env);
    expect(storedChoice(env)).toBeUndefined();
    expect((await call('GET', '/api/mail-provider')).body.kind).toBe('agentmail');
    const queued = queueOne(env, 'Ann', 'ann@lanternrow.invalid');

    await connectGmail(env, google);

    expect(storedChoice(env)).toBe('agentmail');
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'agentmail', ready: true });
    expect(statusOf(env, queued)).toBe('queued');
    await drain(env);
    expect(statusOf(env, queued)).toBe('accepted');
    expect(agentmail.state.sendAttempts).toHaveLength(1);
    expect(google.state.sendAttempts).toHaveLength(0);
  });

  it('does the same when AgentMail is connected after Gmail credentials were saved but before any sign in', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    configureGmailConnector(env.ctx, { clientId: stubGoogleClientId, clientSecret: stubGoogleClientSecret });
    await connectMail(env);
    expect(storedChoice(env)).toBe('agentmail');
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'agentmail', ready: true });
  });

  it('lets a workspace with no ready mail connector take the first one that becomes ready', async () => {
    const env = freshEnv();
    forgetChoice(env);
    await connectGmail(env, google);
    expect(storedChoice(env)).toBe('gmail');
  });
});

describe('switching to a provider that is not ready', () => {
  it('refuses AgentMail without an inbox, naming what is missing, and keeps the provider in use', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectGmail(env, google);
    await configureAgentmailConnector(env.ctx, { token: stubAgentmailKey });
    const refused = await call('POST', '/api/mail-provider', { kind: 'agentmail' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('conflict');
    expect(refused.body.error.message).toContain('no inbox selected');
    expect(storedChoice(env)).toBe('gmail');
  });

  it('refuses Gmail before a sign in, and after the sign in stopped working', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMail(env);
    await call('PUT', '/api/connectors/gmail', credentials);
    const unsigned = await call('POST', '/api/mail-provider', { kind: 'gmail' });
    expect(unsigned.status).toBe(409);
    expect(unsigned.body.error.message).toContain('needs a sign in');

    await connectGmail(env, google);
    markGmailError(env.ctx, 'invalid_grant');
    const broken = await call('POST', '/api/mail-provider', { kind: 'gmail' });
    expect(broken.status).toBe(409);
    expect(broken.body.error.message).toContain('seven days');
    expect(storedChoice(env)).toBe('agentmail');
  });
});

describe('send intent rows and approvals', () => {
  it('carries the address each message was approved to leave from', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMail(env);
    await connectGmail(env, google);
    const viaAgentmail = queueOne(env, 'Bea', 'bea@lanternrow.invalid');
    setMailProvider(env.ctx, { kind: 'gmail' });
    const viaGmail = queueOne(env, 'Cal', 'cal@lanternrow.invalid');
    const rows = (await call('GET', '/api/send-intents')).body.items as { id: string; address: string | null; provider: string }[];
    expect(rows.find((row) => row.id === viaAgentmail)).toMatchObject({ provider: 'agentmail', address: 'crm@stub-mail.invalid' });
    expect(rows.find((row) => row.id === viaGmail)).toMatchObject({ provider: 'gmail', address: stubGmailAddress });
  });

  it('blocks a queued message when the approved message names a different provider than the row', async () => {
    const env = freshEnv();
    await connectMail(env);
    const intentId = queueOne(env, 'Dee', 'dee@lanternrow.invalid');
    const approval = env.db.prepare('SELECT id, payload FROM approval').get() as { id: string; payload: string };
    const payload = JSON.parse(approval.payload) as { messages: { provider?: string }[] };
    payload.messages[0]!.provider = 'gmail';
    const rewritten = JSON.stringify(payload);
    env.db.prepare('UPDATE approval SET payload = ?, payload_hash = ? WHERE id = ?').run(rewritten, hashPayload(rewritten), approval.id);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('blocked');
    expect(intentOf(env, intentId).error).toBe('The message no longer matches what was approved.');
    expect(agentmail.state.sendAttempts).toHaveLength(0);
  });
});
