import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  configureAgentmailConnector,
  configureGmailConnector,
  configureMicrosoftConnector,
  disconnectAgentmailConnector,
  disconnectGmailConnector,
  disconnectMicrosoftConnector,
  markMicrosoftError,
  setMailProvider,
} from '../src/actions/index.js';
import { hashPayload } from '../src/actions/demoResearch.js';
import { buildApp } from '../src/http/app.js';
import { processMailJobs } from '../src/jobs/worker.js';
import { getConnector, getMicrosoftInternals } from '../src/queries/connectors.js';
import { type AgentmailStub, startAgentmailStub, useAgentmailStub } from './agentmailStub.js';
import { type GoogleStub, startGoogleStub, stubGoogleClientId, stubGoogleClientSecret, useGoogleStub } from './googleStub.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { addDraft, addPerson, approve, connectGmail, connectMail, connectMicrosoft, drain, intentOf, queueOne, stage, statusOf } from './mailHelpers.js';
import { type MicrosoftStub, startMicrosoftStub, stubMicrosoftAddress, stubMicrosoftClientId, useMicrosoftStub } from './microsoftStub.js';

let ms: MicrosoftStub;
let google: GoogleStub;
let agentmail: AgentmailStub;
let restoreMs: () => void;
let restoreGoogle: () => void;
let restoreAgentmail: () => void;
const environments: TestEnvironment[] = [];
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  ms = await startMicrosoftStub();
  google = await startGoogleStub();
  agentmail = await startAgentmailStub();
  restoreMs = useMicrosoftStub(ms);
  restoreGoogle = useGoogleStub(google);
  restoreAgentmail = useAgentmailStub(agentmail);
});

afterEach(() => {
  ms.reset();
  google.reset();
  agentmail.reset();
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await ms.close();
  await google.close();
  await agentmail.close();
  restoreMs();
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
  return async (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.inject({ method, url, payload: payload as object | undefined, headers: { host: '127.0.0.1:4720', ...headers } });
    return {
      status: response.statusCode,
      text: response.body,
      location: response.headers.location as string | undefined,
      body: response.body && response.headers['content-type']?.toString().includes('json') ? (JSON.parse(response.body) as any) : null,
    };
  };
}

function callbackPathFor(approvedUrl: string): string {
  const url = new URL(approvedUrl);
  return `${url.pathname}${url.search}`;
}

function auditCount(env: TestEnvironment): number {
  return (env.db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }).n;
}

function storedChoice(env: TestEnvironment): string | undefined {
  const row = env.db.prepare('SELECT settings FROM workspace').get() as { settings: string };
  return (JSON.parse(row.settings) as { mailProvider?: string }).mailProvider;
}

function forgetChoice(env: TestEnvironment): void {
  env.db.prepare("UPDATE workspace SET settings = json_remove(settings, '$.mailProvider')").run();
}

const credentials = { clientId: stubMicrosoftClientId };
// A saved draft is sent again only after twice the request timeout (400 milliseconds here) plus 30 seconds.
const pastTheWait = 31_000;

function noResendOf(env: TestEnvironment, intentId: string): number {
  return (env.db.prepare('SELECT no_resend FROM send_intent WHERE id = ?').get(intentId) as { no_resend: number }).no_resend;
}

function checkTasks(env: TestEnvironment, name: string): number {
  return (env.db.prepare('SELECT COUNT(*) AS n FROM task WHERE title LIKE ? AND status = ?').get(`Check whether the email to ${name}%`, 'open') as { n: number }).n;
}

describe('saving the application id', () => {
  it('validates only the shape and makes no network call, and accepts no secret', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    expect((await call('PUT', '/api/connectors/microsoft', {})).status).toBe(400);
    expect((await call('PUT', '/api/connectors/microsoft', { clientId: 'has space' })).status).toBe(400);
    expect((await call('PUT', '/api/connectors/microsoft', { clientId: '' })).status).toBe(400);
    expect((await call('PUT', '/api/connectors/microsoft', { ...credentials, clientSecret: 'nope' })).status).toBe(400);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM connector').get()).toEqual({ n: 0 });

    const created = await call('PUT', '/api/connectors/microsoft', credentials);
    expect(created.status).toBe(201);
    expect(ms.state.requests).toHaveLength(0);
    expect(created.body).toMatchObject({
      kind: 'microsoft',
      status: 'connected',
      statusMessage: null,
      settings: { clientId: stubMicrosoftClientId, emailAddress: null, address: null, signedIn: false, oauthPending: false, oauthCompletedAt: null, lastSyncAt: null },
    });
    expect(created.body).not.toHaveProperty('tokenMasked');
    expect(created.body).not.toHaveProperty('clientSecretMasked');
    const again = await call('PUT', '/api/connectors/microsoft', credentials);
    expect(again.status).toBe(200);
    expect(again.body.settings.clientId).toBe(stubMicrosoftClientId);
  });

  it('lists the connector without any token, state, or verifier', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    const listing = await call('GET', '/api/connectors');
    const connector = listing.body.items.find((item: { kind: string }) => item.kind === 'microsoft');
    expect(connector.settings.oauthPending).toBe(true);
    const url = new URL(start.body.url);
    expect(listing.text).not.toContain(url.searchParams.get('state'));
    expect(listing.text).not.toContain('verifier');
    expect(listing.text).not.toContain('deltaLink');
    expect(Object.keys(connector).sort()).toEqual(['createdAt', 'id', 'kind', 'settings', 'status', 'statusMessage', 'updatedAt', 'workspaceId']);
  });

  it('needs a saved id before a sign in can start', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const refused = await call('POST', '/api/connectors/microsoft/oauth/start');
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('client) id');
  });
});

describe('the Microsoft sign in flow', () => {
  it('runs start, consent, and callback, then stores tokens and the address and redirects with 303', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${ms.url}/common/oauth2/v2.0/authorize`);
    expect(Object.fromEntries(url.searchParams.entries())).toMatchObject({
      client_id: stubMicrosoftClientId,
      redirect_uri: 'http://localhost:4720/api/connectors/microsoft/oauth/callback',
      response_type: 'code',
      scope: 'offline_access Mail.ReadWrite Mail.Send User.Read',
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    expect(url.searchParams.get('client_secret')).toBeNull();
    expect(url.searchParams.get('state')!.length).toBeGreaterThan(20);
    expect(url.searchParams.get('code_challenge')!.length).toBeGreaterThan(20);
    const baseline = getConnector(env.db, env.workspaceId, 'microsoft')!.updatedAt;

    const callback = await call('GET', callbackPathFor(ms.approve(start.body.url)));
    expect(callback.status).toBe(303);
    expect(callback.location).toBe('/settings/connectors');
    const exchange = ms.state.tokenRequests.find((request) => request.grantType === 'authorization_code')!;
    expect(exchange.verifierMatched).toBe(true);
    expect(exchange.form.redirect_uri).toBe('http://localhost:4720/api/connectors/microsoft/oauth/callback');
    // A public client: no secret goes with the code.
    expect(exchange.form.client_secret).toBeUndefined();

    const connector = getConnector(env.db, env.workspaceId, 'microsoft')!;
    expect(connector.updatedAt > baseline).toBe(true);
    expect(connector.status).toBe('connected');
    expect(connector.settings).toMatchObject({ emailAddress: stubMicrosoftAddress, address: stubMicrosoftAddress, signedIn: true, oauthPending: false });
    expect(connector.settings.oauthCompletedAt).not.toBeNull();
    const stored = getMicrosoftInternals(env.db, env.workspaceId)!;
    expect(stored.secret.refreshToken).toMatch(/^M\.C500\.stub-refresh/);
    expect(stored.secret.accessToken).toMatch(/^eyJ\./);
    expect(stored.settings.pending).toBeUndefined();
    expect(String(stored.settings.deltaLink)).toMatch(/^start:/);

    const listing = await call('GET', '/api/connectors');
    expect(listing.text).not.toContain(stored.secret.refreshToken);
    expect(listing.text).not.toContain(stored.secret.accessToken);
    expect((await call('GET', '/api/mail-provider')).body).toEqual({ kind: 'microsoft', address: stubMicrosoftAddress, ready: true, lastSyncAt: null });
  });

  it('reads the address from GET /me: the mail field first, then the user principal name', async () => {
    const env = freshEnv();
    ms.state.profileBody = { mail: null, userPrincipalName: 'Principal.Only@Contoso.Invalid', displayName: 'X' };
    await connectMicrosoft(env, ms);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.address).toBe('principal.only@contoso.invalid');
    const profile = ms.state.requests.find((request) => request.path === '/v1.0/me')!;
    expect(profile.query.$select).toBe('mail,userPrincipalName,displayName');
    ms.reset();
    ms.state.profileBody = { mail: 'Real.Mail@Contoso.Invalid', userPrincipalName: 'upn@contoso.invalid' };
    const other = freshEnv();
    await connectMicrosoft(other, ms);
    expect(getConnector(other.db, other.workspaceId, 'microsoft')!.settings.address).toBe('real.mail@contoso.invalid');
  });

  it('refuses a sign in whose account has no mail address', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    ms.state.profileBody = { displayName: 'No address', userPrincipalName: 'not-an-address' };
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    const refused = await call('GET', callbackPathFor(ms.approve(start.body.url)));
    expect(refused.location).toBe('/settings/connectors?microsoft_error=profile_failed');
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.signedIn).toBe(false);
  });

  it('sends the browser back to the page that started the sign in when it is a loopback origin', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const start = await call('POST', '/api/connectors/microsoft/oauth/start', undefined, { origin: 'http://127.0.0.1:5173' });
    const callback = await call('GET', callbackPathFor(ms.approve(start.body.url)));
    expect(callback.location).toBe('http://127.0.0.1:5173/settings/connectors');
    // A cross site web origin cannot even start a sign in: the app wide origin guard refuses the POST.
    const other = await call('POST', '/api/connectors/microsoft/oauth/start', undefined, { origin: 'https://evil.example.org' });
    expect(other.status).toBe(403);
  });

  it('refuses a callback whose state does not match, records nothing, and keeps the sign in under way', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    const baseline = getConnector(env.db, env.workspaceId, 'microsoft')!.updatedAt;
    const auditBefore = auditCount(env);
    const approved = new URL(ms.approve(start.body.url));
    approved.searchParams.set('state', 'forged-state');
    const refused = await call('GET', callbackPathFor(approved.toString()));
    expect(refused.status).toBe(303);
    expect(refused.location).toBe('/settings/connectors?microsoft_error=state_mismatch');
    expect(ms.state.tokenRequests).toHaveLength(0);
    const connector = getConnector(env.db, env.workspaceId, 'microsoft')!;
    expect(connector.settings.signedIn).toBe(false);
    expect(connector.statusMessage).toBeNull();
    expect(connector.updatedAt).toBe(baseline);
    expect(connector.status).toBe('connected');
    expect(auditCount(env)).toBe(auditBefore);
    expect(connector.settings.oauthPending).toBe(true);
    const good = await call('GET', callbackPathFor(ms.approve(start.body.url)));
    expect(good.location).toBe('/settings/connectors');
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.signedIn).toBe(true);
  });

  it('records nothing for a callback when no sign in is pending, even one carrying a Microsoft error', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const baseline = getConnector(env.db, env.workspaceId, 'microsoft')!.updatedAt;
    const auditBefore = auditCount(env);
    for (const query of ['?code=abc&state=anything', '?state=', '?error=access_denied&error_description=AADSTS65001%3A+forged&state=x', '']) {
      const refused = await call('GET', `/api/connectors/microsoft/oauth/callback${query}`);
      expect(refused.status).toBe(303);
      expect(refused.location).toBe('/settings/connectors?microsoft_error=state_mismatch');
    }
    const connector = getConnector(env.db, env.workspaceId, 'microsoft')!;
    expect(connector.statusMessage).toBeNull();
    expect(connector.updatedAt).toBe(baseline);
    expect(connector.settings.oauthCompletedAt).toBeNull();
    expect(auditCount(env)).toBe(auditBefore);
    expect(ms.state.tokenRequests).toHaveLength(0);
  });

  it('sets oauthCompletedAt only when a sign in finishes, and a failed attempt moves updatedAt without it', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.oauthCompletedAt).toBeNull();

    const cancelled = await call('POST', '/api/connectors/microsoft/oauth/start');
    const beforeFailure = getConnector(env.db, env.workspaceId, 'microsoft')!;
    await call('GET', callbackPathFor(ms.approve(cancelled.body.url, 'deny')));
    const afterFailure = getConnector(env.db, env.workspaceId, 'microsoft')!;
    expect(afterFailure.updatedAt > beforeFailure.updatedAt).toBe(true);
    expect(afterFailure.statusMessage).toContain('cancelled');
    expect(afterFailure.settings.oauthCompletedAt).toBeNull();

    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    await call('GET', callbackPathFor(ms.approve(start.body.url)));
    const afterSuccess = getConnector(env.db, env.workspaceId, 'microsoft')!;
    expect(afterSuccess.settings.signedIn).toBe(true);
    expect(afterSuccess.settings.oauthCompletedAt).not.toBeNull();
    expect(afterSuccess.statusMessage).toBeNull();
    const completed = afterSuccess.settings.oauthCompletedAt;

    const again = await call('POST', '/api/connectors/microsoft/oauth/start');
    await call('GET', callbackPathFor(ms.approve(again.body.url, 'deny')));
    const afterSecondFailure = getConnector(env.db, env.workspaceId, 'microsoft')!;
    expect(afterSecondFailure.settings.oauthCompletedAt).toBe(completed);
    expect(afterSecondFailure.updatedAt > afterSuccess.updatedAt).toBe(true);
    expect(afterSecondFailure.statusMessage).toContain('cancelled');

    const third = await call('POST', '/api/connectors/microsoft/oauth/start');
    await call('GET', callbackPathFor(ms.approve(third.body.url)));
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.oauthCompletedAt! > completed!).toBe(true);
  });

  it('refuses a callback with no state, and a replayed callback', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    expect((await call('GET', '/api/connectors/microsoft/oauth/callback?code=abc')).location).toBe('/settings/connectors?microsoft_error=state_mismatch');
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    const path = callbackPathFor(ms.approve(start.body.url));
    expect((await call('GET', path)).location).toBe('/settings/connectors');
    expect((await call('GET', path)).location).toBe('/settings/connectors?microsoft_error=state_mismatch');
    expect(ms.state.tokenRequests.filter((request) => request.grantType === 'authorization_code')).toHaveLength(1);
  });

  it('refuses a sign in that took more than fifteen minutes, and accepts one just inside', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    env.advance(16 * 60 * 1000);
    const refused = await call('GET', callbackPathFor(ms.approve(start.body.url)));
    expect(refused.location).toBe('/settings/connectors?microsoft_error=expired');
    expect(ms.state.tokenRequests).toHaveLength(0);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.signedIn).toBe(false);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.statusMessage).toContain('15 minutes');

    const second = await call('POST', '/api/connectors/microsoft/oauth/start');
    env.advance(14 * 60 * 1000);
    expect((await call('GET', callbackPathFor(ms.approve(second.body.url)))).location).toBe('/settings/connectors');
  });

  it('reports a cancelled consent with its own code', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    const denied = await call('GET', callbackPathFor(ms.approve(start.body.url, 'deny')));
    expect(denied.location).toBe('/settings/connectors?microsoft_error=access_denied');
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.statusMessage).toContain('cancelled');
  });

  it("puts Microsoft's own admin consent sentence on the connector, verbatim and without the trace lines", async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const sentence = 'AADSTS65001: The user or administrator has not consented to use the application with ID. Send an interactive authorization request for this user and resource.';
    ms.state.consentError = { error: 'consent_required', description: `${sentence}\r\nTrace ID: 0000\r\nCorrelation ID: 1111` };
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    const blocked = await call('GET', callbackPathFor(ms.approve(start.body.url)));
    expect(blocked.location).toBe('/settings/connectors?microsoft_error=microsoft_error');
    const connector = getConnector(env.db, env.workspaceId, 'microsoft')!;
    expect(connector.statusMessage).toBe(sentence);
    expect(connector.settings.signedIn).toBe(false);
    expect(connector.settings.oauthCompletedAt).toBeNull();
    expect(ms.state.tokenRequests).toHaveLength(0);

    // The same sentence on an access_denied keeps that code for the card.
    ms.state.consentError = { error: 'access_denied', description: 'AADSTS90094: An administrator needs to grant permission. Contact your admin.\r\nTrace ID: 2222' };
    const second = await call('POST', '/api/connectors/microsoft/oauth/start');
    const again = await call('GET', callbackPathFor(ms.approve(second.body.url)));
    expect(again.location).toBe('/settings/connectors?microsoft_error=access_denied');
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.statusMessage).toBe('AADSTS90094: An administrator needs to grant permission. Contact your admin.');
  });

  it('refuses a sign in when a mail permission was left unticked', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    ms.state.grantedScopes = ['Mail.Send', 'User.Read'];
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    const refused = await call('GET', callbackPathFor(ms.approve(start.body.url)));
    expect(refused.location).toBe('/settings/connectors?microsoft_error=missing_permissions');
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.signedIn).toBe(false);
    expect(ms.state.paths).not.toContain('GET /v1.0/me');
  });

  it('accepts granted permissions written with the Graph prefix or in another case', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    ms.state.grantedScopes = ['MAIL.READWRITE', 'mail.send', 'User.Read'];
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    expect((await call('GET', callbackPathFor(ms.approve(start.body.url)))).location).toBe('/settings/connectors');
  });

  it('reports an exchange failure with a short code and the detail on the connector', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    const path = callbackPathFor(ms.approve(start.body.url));
    ms.state.tokenMode = 'invalid_client';
    const failed = await call('GET', path);
    expect(failed.location).toBe('/settings/connectors?microsoft_error=exchange_failed');
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.statusMessage).toContain('application (client) id');
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.signedIn).toBe(false);
  });

  it('tells a person whose app registration is not a public client exactly what to switch on', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    const path = callbackPathFor(ms.approve(start.body.url));
    ms.state.tokenMode = 'public_client';
    const failed = await call('GET', path);
    expect(failed.location).toBe('/settings/connectors?microsoft_error=exchange_failed');
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.statusMessage).toContain('Allow public client flows');
  });

  it('redirects with a code and stores nothing when there is no saved id', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const refused = await call('GET', '/api/connectors/microsoft/oauth/callback?code=x&state=y');
    expect(refused.status).toBe(303);
    expect(refused.location).toBe('/settings/connectors?microsoft_error=no_connector');
  });

  it('signing in again as the same account keeps the saved position, and a different account blocks queued mail', async () => {
    const env = freshEnv();
    await connectMicrosoft(env, ms);
    const queued = queueOne(env, 'Ona', 'ona@lanternrow.invalid');
    env.db.prepare("UPDATE connector SET settings = json_set(settings, '$.deltaLink', 'delta:http://example.invalid/saved') WHERE kind = 'microsoft'").run();
    await connectMicrosoft(env, ms);
    expect(getMicrosoftInternals(env.db, env.workspaceId)!.settings.deltaLink).toBe('delta:http://example.invalid/saved');
    expect(statusOf(env, queued)).toBe('queued');

    ms.state.address = 'another@outlook-stub.invalid';
    await connectMicrosoft(env, ms);
    expect(intentOf(env, queued)).toMatchObject({ status: 'blocked' });
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.address).toBe('another@outlook-stub.invalid');
    expect(String(getMicrosoftInternals(env.db, env.workspaceId)!.settings.deltaLink)).toMatch(/^start:/);
  });
});

describe('the mail provider in use, with three providers', () => {
  it('is null before any mail connector, then set by the first one that is ready', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    expect((await call('GET', '/api/mail-provider')).body).toBeNull();
    await call('PUT', '/api/connectors/microsoft', credentials);
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'microsoft', address: null, ready: false });
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    await call('GET', callbackPathFor(ms.approve(start.body.url)));
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'microsoft', address: stubMicrosoftAddress, ready: true });
    expect(storedChoice(env)).toBe('microsoft');
  });

  it('keeps the first provider when others connect, and switches among all three on request', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMail(env);
    await connectGmail(env, google);
    await connectMicrosoft(env, ms);
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'agentmail', ready: true });
    const toMicrosoft = await call('POST', '/api/mail-provider', { kind: 'microsoft' });
    expect(toMicrosoft.status).toBe(200);
    expect(toMicrosoft.body).toEqual({ kind: 'microsoft', address: stubMicrosoftAddress, ready: true, lastSyncAt: null });
    expect((await call('POST', '/api/mail-provider', { kind: 'gmail' })).body.kind).toBe('gmail');
    expect((await call('POST', '/api/mail-provider', { kind: 'microsoft' })).body.kind).toBe('microsoft');
    expect((await call('GET', '/api/mail-provider')).body.kind).toBe('microsoft');
  });

  it('validates the switch', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const notConnected = await call('POST', '/api/mail-provider', { kind: 'microsoft' });
    expect(notConnected.status).toBe(409);
    expect(notConnected.body.error.message).toContain('Microsoft is not connected');
  });

  it('stages under the provider in use: the preflight reads that connector address', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectGmail(env, google);
    await connectMicrosoft(env, ms);
    const person = addPerson(env, 'Pat', 'pat@lanternrow.invalid');
    const viaAgentmail = stage(env, [addDraft(env, person.id, 'One', 'Body one')]);
    expect(viaAgentmail.intents[0]).toMatchObject({ provider: 'agentmail' });
    setMailProvider(env.ctx, { kind: 'microsoft' });
    const person2 = addPerson(env, 'Quin', 'quin@lanternrow.invalid');
    const viaMicrosoft = stage(env, [addDraft(env, person2.id, 'Two', 'Body two')]);
    expect(viaMicrosoft.intents[0]).toMatchObject({ provider: 'microsoft', inboxId: stubMicrosoftAddress });
    expect((viaMicrosoft.approval!.payload as any).inboxEmail).toBe(stubMicrosoftAddress);
    expect((viaMicrosoft.approval!.payload as any).mailProvider).toBe('microsoft');
  });

  it('excludes everything with no_inbox when the provider in use has no sending address', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const person = addPerson(env, 'Rex', 'rex@lanternrow.invalid');
    const staged = stage(env, [addDraft(env, person.id, 'Hi', 'Body')]);
    expect(staged.approval).toBeNull();
    expect(staged.excluded[0]!.reason).toBe('no_inbox');
  });

  it('blocks messages queued for a provider that was switched away from, and sends nothing from any of the three', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectGmail(env, google);
    await connectMicrosoft(env, ms);
    const viaAgentmail = queueOne(env, 'Sam', 'sam@lanternrow.invalid');
    setMailProvider(env.ctx, { kind: 'microsoft' });
    expect(intentOf(env, viaAgentmail)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    const viaMicrosoft = queueOne(env, 'Tess', 'tess@lanternrow.invalid');
    expect(intentOf(env, viaMicrosoft).provider).toBe('microsoft');
    setMailProvider(env.ctx, { kind: 'gmail' });
    expect(intentOf(env, viaMicrosoft)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    const viaGmail = queueOne(env, 'Uri', 'uri@lanternrow.invalid');
    setMailProvider(env.ctx, { kind: 'agentmail' });
    expect(intentOf(env, viaGmail)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    await drain(env);
    expect(agentmail.state.sendAttempts).toHaveLength(0);
    expect(google.state.sendAttempts).toHaveLength(0);
    expect(ms.state.createAttempts).toHaveLength(0);
    expect(ms.state.sendAttempts).toHaveLength(0);
  });

  it('re-checks the provider at submit, so a switch that bypassed the action still cannot send', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectMicrosoft(env, ms);
    setMailProvider(env.ctx, { kind: 'microsoft' });
    const queued = queueOne(env, 'Ula', 'ula@lanternrow.invalid');
    env.db.prepare("UPDATE workspace SET settings = json_set(COALESCE(settings, '{}'), '$.mailProvider', 'agentmail') WHERE id = ?").run(env.workspaceId);
    await drain(env);
    expect(intentOf(env, queued)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    expect(ms.state.createAttempts).toHaveLength(0);
    expect(ms.state.sendAttempts).toHaveLength(0);
  });

  it('refuses to approve messages staged for a provider that is no longer in use', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectMicrosoft(env, ms);
    const person = addPerson(env, 'Vic', 'vic@lanternrow.invalid');
    const staged = stage(env, [addDraft(env, person.id, 'Hi', 'Body')]);
    setMailProvider(env.ctx, { kind: 'microsoft' });
    expect(() => approve(env, staged.approval!.id)).toThrowError(/sending connector changed/);
    expect(statusOf(env, staged.intents[0]!.id)).toBe('awaiting_approval');
  });

  it('keeps reconciling an unknown intent with the provider that staged it after a switch', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectMicrosoft(env, ms);
    setMailProvider(env.ctx, { kind: 'microsoft' });
    ms.state.sendScript.push({ type: 'process_then_respond', status: 502 });
    const unknown = queueOne(env, 'Wil', 'wil@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, unknown)).toBe('unknown');
    setMailProvider(env.ctx, { kind: 'agentmail' });
    expect(statusOf(env, unknown)).toBe('unknown');
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, unknown)).toBe('accepted');
    expect(agentmail.state.sendAttempts).toHaveLength(0);
    expect(ms.state.sent).toHaveLength(1);
  });

  it('never re-sends an unsent draft after the provider was switched away from', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectMicrosoft(env, ms);
    setMailProvider(env.ctx, { kind: 'microsoft' });
    ms.state.sendScript.push({ type: 'respond', status: 503 });
    const unknown = queueOne(env, 'Xer', 'xer@lanternrow.invalid');
    await drain(env);
    setMailProvider(env.ctx, { kind: 'agentmail' });
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, unknown)).toBe('unknown');
    expect(ms.state.sendAttempts).toHaveLength(1);
    expect(ms.state.sent).toHaveLength(0);
  });

  it('does not mark the message when the provider is switched away, so the draft is sent again once Microsoft is in use again', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectMicrosoft(env, ms);
    setMailProvider(env.ctx, { kind: 'microsoft' });
    ms.state.sendScript.push({ type: 'respond', status: 503 });
    const unknown = queueOne(env, 'Yara', 'yara@lanternrow.invalid');
    await drain(env);
    setMailProvider(env.ctx, { kind: 'agentmail' });
    expect(noResendOf(env, unknown)).toBe(0);
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, unknown)).toBe('unknown');
    expect(ms.state.sendAttempts).toHaveLength(1);
    setMailProvider(env.ctx, { kind: 'microsoft' });
    expect(noResendOf(env, unknown)).toBe(0);
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, unknown)).toBe('accepted');
    expect(ms.state.sendAttempts).toHaveLength(2);
    expect(ms.state.sent).toHaveLength(1);
  });

  it('shows the provider on send intent rows, the mail summary, and the approval', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMicrosoft(env, ms);
    queueOne(env, 'Xan', 'xan@lanternrow.invalid');
    const rows = await call('GET', '/api/send-intents');
    expect(rows.body.items[0]).toMatchObject({ provider: 'microsoft', inboxId: stubMicrosoftAddress, status: 'queued' });
    const summary = await call('GET', '/api/mail/summary');
    expect(summary.body).toMatchObject({ provider: 'microsoft', inbox: { connected: true, inboxEmail: stubMicrosoftAddress } });
    const approvals = await call('GET', '/api/approvals');
    expect(approvals.body.items[0].payload.mailProvider).toBe('microsoft');
  });
});

describe('removing the Microsoft connector', () => {
  it('blocks queued and approved mail, keeps submitting and unknown intents with the reason added, and deletes the row', async () => {
    const env = freshEnv();
    await connectMicrosoft(env, ms);
    const queued = queueOne(env, 'Yul', 'yul@lanternrow.invalid');
    const approved = queueOne(env, 'Zed', 'zed@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'approved' WHERE id = ?").run(approved);
    const submitting = queueOne(env, 'Abby', 'abby@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'submitting' WHERE id = ?").run(submitting);
    const unknown = queueOne(env, 'Bram', 'bram@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'unknown', error = 'Outcome unknown.' WHERE id = ?").run(unknown);

    disconnectMicrosoftConnector(env.ctx);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')).toBeNull();
    expect(intentOf(env, queued)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    expect(intentOf(env, approved)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    expect(intentOf(env, submitting)).toMatchObject({ status: 'submitting', error: 'connector_removed' });
    expect(intentOf(env, unknown)).toMatchObject({ status: 'unknown', error: 'Outcome unknown. connector_removed' });
    await drain(env);
    expect(ms.state.createAttempts).toHaveLength(0);
    expect(ms.state.sendAttempts).toHaveLength(0);
    const call = await appFor(env);
    expect((await call('GET', '/api/mail-provider')).body).toBeNull();
  });

  it('marks the unknown messages so the saved draft is only read after the same account signs in again, never sent', async () => {
    const env = freshEnv();
    await connectMicrosoft(env, ms);
    // One draft was never sent, and one was sent although the answer was lost.
    ms.state.sendScript.push({ type: 'respond', status: 503 }, { type: 'process_then_respond', status: 502 });
    const unsent = queueOne(env, 'Bo2', 'bo2@lanternrow.invalid');
    const sent = queueOne(env, 'Cy2', 'cy2@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, unsent)).toBe('unknown');
    expect(statusOf(env, sent)).toBe('unknown');
    expect(noResendOf(env, unsent)).toBe(0);
    const queued = queueOne(env, 'Di2', 'di2@lanternrow.invalid');

    disconnectMicrosoftConnector(env.ctx);
    expect(noResendOf(env, unsent)).toBe(1);
    expect(noResendOf(env, sent)).toBe(1);
    expect(noResendOf(env, queued)).toBe(0);

    await connectMicrosoft(env, ms);
    for (let round = 0; round < 4; round += 1) {
      env.advance(pastTheWait);
      await processMailJobs(env.ctx);
    }
    // Found means accepted. Still a draft means unknown, with the task, and it is never sent.
    expect(statusOf(env, sent)).toBe('accepted');
    const stillDraft = intentOf(env, unsent);
    expect(stillDraft.status).toBe('unknown');
    expect(stillDraft.error).toContain('only reads Outlook and will not send the saved draft again');
    expect(checkTasks(env, 'Bo2')).toBe(1);
    expect(ms.state.sendAttempts).toHaveLength(2);
    expect(ms.state.sent).toHaveLength(1);
    // Not even a day later, within the checking window.
    env.advance(3 * 3_600_000);
    await processMailJobs(env.ctx);
    expect(ms.state.sendAttempts).toHaveLength(2);
    expect(statusOf(env, unsent)).toBe('unknown');
  });

  it('leaves the other providers and their queued mail alone, and moves the choice to a ready one', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMail(env);
    await connectGmail(env, google);
    await connectMicrosoft(env, ms);
    setMailProvider(env.ctx, { kind: 'microsoft' });
    const viaMicrosoft = queueOne(env, 'Cato', 'cato@lanternrow.invalid');
    setMailProvider(env.ctx, { kind: 'gmail' });
    const viaGmail = queueOne(env, 'Dara', 'dara@lanternrow.invalid');
    setMailProvider(env.ctx, { kind: 'microsoft' });
    expect(statusOf(env, viaGmail)).toBe('blocked');
    const gone = await call('DELETE', '/api/connectors/microsoft');
    expect(gone.status).toBe(204);
    expect(statusOf(env, viaMicrosoft)).toBe('blocked');
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'agentmail', ready: true });
    expect(getConnector(env.db, env.workspaceId, 'agentmail')).not.toBeNull();
    expect(getConnector(env.db, env.workspaceId, 'gmail')).not.toBeNull();
    expect((await call('DELETE', '/api/connectors/microsoft')).status).toBe(404);
  });

  it('removing the other providers does not touch Microsoft intents', async () => {
    const env = freshEnv();
    await connectMail(env);
    await connectGmail(env, google);
    await connectMicrosoft(env, ms);
    setMailProvider(env.ctx, { kind: 'microsoft' });
    const viaMicrosoft = queueOne(env, 'Eli', 'eli@lanternrow.invalid');
    disconnectAgentmailConnector(env.ctx);
    disconnectGmailConnector(env.ctx);
    expect(statusOf(env, viaMicrosoft)).toBe('queued');
    await drain(env);
    expect(statusOf(env, viaMicrosoft)).toBe('accepted');
  });
});

describe('changing the application id', () => {
  it('signs the account out when the id changes, and blocks mail approved to leave from it', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMicrosoft(env, ms);
    const queued = queueOne(env, 'Fay', 'fay@lanternrow.invalid');
    const changed = await call('PUT', '/api/connectors/microsoft', { clientId: '00000000-0000-4000-8000-000000000002' });
    expect(changed.status).toBe(200);
    expect(changed.body.settings).toMatchObject({ clientId: '00000000-0000-4000-8000-000000000002', signedIn: false, emailAddress: null, oauthCompletedAt: null });
    expect(getMicrosoftInternals(env.db, env.workspaceId)!.secret).toEqual({ accessToken: null, refreshToken: null, expiresAt: null });
    expect(statusOf(env, queued)).toBe('blocked');
    await drain(env);
    expect(ms.state.createAttempts).toHaveLength(0);
  });

  it('keeps the sign in when the same id is saved again', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMicrosoft(env, ms);
    const kept = await call('PUT', '/api/connectors/microsoft', credentials);
    expect(kept.body.settings.signedIn).toBe(true);
  });
});

describe('connecting a second provider never moves sending', () => {
  it('stores the provider already sending before Microsoft signs in, so the queued AgentMail message stays put', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMail(env);
    forgetChoice(env);
    expect((await call('GET', '/api/mail-provider')).body.kind).toBe('agentmail');
    const queued = queueOne(env, 'Ann', 'ann@lanternrow.invalid');

    await connectMicrosoft(env, ms);

    expect(storedChoice(env)).toBe('agentmail');
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'agentmail', ready: true });
    expect(statusOf(env, queued)).toBe('queued');
    await drain(env);
    expect(statusOf(env, queued)).toBe('accepted');
    expect(agentmail.state.sendAttempts).toHaveLength(1);
    expect(ms.state.createAttempts).toHaveLength(0);
  });

  it('does the same when Gmail is the one sending and Microsoft connects', async () => {
    const env = freshEnv();
    configureGmailConnector(env.ctx, { clientId: stubGoogleClientId, clientSecret: stubGoogleClientSecret });
    await connectGmail(env, google);
    forgetChoice(env);
    await connectMicrosoft(env, ms);
    expect(storedChoice(env)).toBe('gmail');
  });

  it('does the same when AgentMail is connected after Microsoft credentials were saved but before any sign in', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    configureMicrosoftConnector(env.ctx, credentials);
    await connectMail(env);
    expect(storedChoice(env)).toBe('agentmail');
    expect((await call('GET', '/api/mail-provider')).body).toMatchObject({ kind: 'agentmail', ready: true });
  });

  it('lets a workspace with no ready mail connector take the first one that becomes ready', async () => {
    const env = freshEnv();
    forgetChoice(env);
    await connectMicrosoft(env, ms);
    expect(storedChoice(env)).toBe('microsoft');
  });
});

describe('switching to a Microsoft account that is not ready', () => {
  it('refuses Microsoft before a sign in, and after the sign in stopped working', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMail(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    const unsigned = await call('POST', '/api/mail-provider', { kind: 'microsoft' });
    expect(unsigned.status).toBe(409);
    expect(unsigned.body.error.message).toContain('needs a sign in');

    await connectMicrosoft(env, ms);
    markMicrosoftError(env.ctx, 'invalid_grant');
    const broken = await call('POST', '/api/mail-provider', { kind: 'microsoft' });
    expect(broken.status).toBe(409);
    expect(broken.body.error.message).toContain('Sign in with Microsoft again');
    expect(storedChoice(env)).toBe('agentmail');
  });
});

describe('send intent rows and approvals', () => {
  it('carries the address each message was approved to leave from', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMail(env);
    await connectMicrosoft(env, ms);
    const viaAgentmail = queueOne(env, 'Bea', 'bea@lanternrow.invalid');
    setMailProvider(env.ctx, { kind: 'microsoft' });
    const viaMicrosoft = queueOne(env, 'Cal', 'cal@lanternrow.invalid');
    const rows = (await call('GET', '/api/send-intents')).body.items as { id: string; address: string | null; provider: string }[];
    expect(rows.find((row) => row.id === viaAgentmail)).toMatchObject({ provider: 'agentmail', address: 'crm@stub-mail.invalid' });
    expect(rows.find((row) => row.id === viaMicrosoft)).toMatchObject({ provider: 'microsoft', address: stubMicrosoftAddress });
  });

  it('blocks a queued message when the approved message names a different provider than the row', async () => {
    const env = freshEnv();
    await connectMicrosoft(env, ms);
    const intentId = queueOne(env, 'Dee', 'dee@lanternrow.invalid');
    const approval = env.db.prepare('SELECT id, payload FROM approval').get() as { id: string; payload: string };
    const payload = JSON.parse(approval.payload) as { messages: { provider?: string }[] };
    payload.messages[0]!.provider = 'gmail';
    const rewritten = JSON.stringify(payload);
    env.db.prepare('UPDATE approval SET payload = ?, payload_hash = ? WHERE id = ?').run(rewritten, hashPayload(rewritten), approval.id);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('blocked');
    expect(intentOf(env, intentId).error).toBe('The message no longer matches what was approved.');
    expect(ms.state.createAttempts).toHaveLength(0);
  });
});

describe('route contract for the Microsoft connector', () => {
  it('serves the connector entry with the shape the card reads', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await connectMicrosoft(env, ms);
    const listing = await call('GET', '/api/connectors');
    const entry = listing.body.items.find((item: { kind: string }) => item.kind === 'microsoft');
    expect(entry).toMatchObject({
      kind: 'microsoft',
      status: 'connected',
      statusMessage: null,
      settings: {
        clientId: stubMicrosoftClientId,
        emailAddress: stubMicrosoftAddress,
        address: stubMicrosoftAddress,
        signedIn: true,
        oauthPending: false,
        lastSyncAt: null,
        lastSyncError: null,
      },
    });
    expect(typeof entry.settings.oauthCompletedAt).toBe('string');
    expect(typeof entry.updatedAt).toBe('string');
  });

  it('answers the oauth start with a url and a missing id with the conflict envelope', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    const refused = await call('POST', '/api/connectors/microsoft/oauth/start');
    expect(refused.body.error.code).toBe('conflict');
    await call('PUT', '/api/connectors/microsoft', credentials);
    const start = await call('POST', '/api/connectors/microsoft/oauth/start');
    expect(Object.keys(start.body)).toEqual(['url']);
  });

  it('removes the connector with 204 and a second removal is a 404 in the standard envelope', async () => {
    const env = freshEnv();
    const call = await appFor(env);
    await call('PUT', '/api/connectors/microsoft', credentials);
    expect((await call('DELETE', '/api/connectors/microsoft')).status).toBe(204);
    const again = await call('DELETE', '/api/connectors/microsoft');
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('not_found');
  });
});
