import {
  completeGmailOAuth,
  completeMicrosoftOAuth,
  configureAgentmailConnector,
  configureGmailConnector,
  configureImapConnector,
  configureMicrosoftConnector,
  createActivityIn,
  createPerson,
  decideApproval,
  mutate,
  prepareSendIntents,
  startGmailOAuth,
  startMicrosoftOAuth,
} from '../src/actions/index.js';
import { processMailJobs } from '../src/jobs/worker.js';
import { getSendIntent } from '../src/queries/sendIntents.js';
import type { TestEnvironment } from './helpers.js';
import { stubAgentmailKey, stubInboxId } from './agentmailStub.js';
import { type GoogleStub, stubGoogleClientId, stubGoogleClientSecret } from './googleStub.js';
import { type MicrosoftStub, stubMicrosoftClientId } from './microsoftStub.js';
import { stubImapAddress, stubImapPassword } from './mailTransportStub.js';

export async function connectMail(env: TestEnvironment): Promise<void> {
  await configureAgentmailConnector(env.ctx, { token: stubAgentmailKey, inboxId: stubInboxId });
}

// Saves the client, then walks the whole sign in against the stub: start, consent, callback.
export async function connectGmail(env: TestEnvironment, google: GoogleStub): Promise<void> {
  configureGmailConnector(env.ctx, { clientId: stubGoogleClientId, clientSecret: stubGoogleClientSecret });
  const { url } = startGmailOAuth(env.ctx);
  const callback = new URL(google.approve(url));
  const outcome = await completeGmailOAuth(env.ctx, {
    code: callback.searchParams.get('code') ?? undefined,
    state: callback.searchParams.get('state') ?? undefined,
  });
  if (!outcome.ok) throw new Error(`The stub sign in failed: ${outcome.errorCode}`);
}

// Saves the application id, then walks the whole sign in against the stub: start, consent, callback.
export async function connectMicrosoft(env: TestEnvironment, microsoft: MicrosoftStub): Promise<void> {
  configureMicrosoftConnector(env.ctx, { clientId: stubMicrosoftClientId });
  const { url } = startMicrosoftOAuth(env.ctx);
  const callback = new URL(microsoft.approve(url));
  const outcome = await completeMicrosoftOAuth(env.ctx, {
    code: callback.searchParams.get('code') ?? undefined,
    state: callback.searchParams.get('state') ?? undefined,
  });
  if (!outcome.ok) throw new Error(`The stub sign in failed: ${outcome.errorCode}`);
}

export function addPerson(env: TestEnvironment, firstName: string, email: string | null) {
  return createPerson(env.ctx, { firstName, lastName: 'Testwell', email });
}

// Saves a draft the way an approved draft run does: a note on the person with the subject and body in the stored format.
export function addDraft(env: TestEnvironment, personId: string, subject: string, body: string, email = 'unused@stub-mail.invalid'): string {
  const text = ['Draft, not sent.', '', `To: ${email}`, `Subject: ${subject}`, '', body, '', 'Facts the model says it used:', '- No record facts listed'].join('\n');
  return mutate(env.ctx, (tx) => createActivityIn(tx, { entityType: 'person', entityId: personId, kind: 'email_draft', body: text })).id;
}

export function stage(env: TestEnvironment, draftActivityIds: string[]) {
  return prepareSendIntents(env.ctx, { draftActivityIds });
}

export function approve(env: TestEnvironment, approvalId: string) {
  return decideApproval(env.ctx, approvalId, { decision: 'approve' });
}

// Stages one draft for a new person, approves it, and returns the queued intent id.
export function queueOne(env: TestEnvironment, name: string, email: string, subject = `Hello ${name}`): string {
  const person = addPerson(env, name, email);
  const draft = addDraft(env, person.id, subject, `Hi ${name}, this is a test message.`);
  const staged = stage(env, [draft]);
  approve(env, staged.approval!.id);
  return staged.intents[0]!.id;
}

export async function drain(env: TestEnvironment): Promise<void> {
  for (let round = 0; round < 3; round += 1) await processMailJobs(env.ctx);
}

export function statusOf(env: TestEnvironment, intentId: string): string {
  return getSendIntent(env.db, env.workspaceId, intentId)!.status;
}

export function intentOf(env: TestEnvironment, intentId: string) {
  return getSendIntent(env.db, env.workspaceId, intentId)!;
}

// Inserts a sent-today intent directly, so cap tests do not need dozens of sends.
export function insertAcceptedToday(env: TestEnvironment, personId: string, count: number): void {
  const now = env.ctx.now();
  for (let index = 0; index < count; index += 1) {
    const id = env.ctx.newId('snd');
    env.db
      .prepare(
        `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, submitted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'x', 'accepted', ?, ?)`,
      )
      .run(id, now, env.workspaceId, personId, stubInboxId, `filler${index}@filler.invalid`, `Filler ${index}`, 'body', now, now);
  }
}

// Connects the IMAP and SMTP connector against the transport stub, with the Fastmail preset unless told otherwise.
export async function connectImap(env: TestEnvironment, input: Record<string, unknown> = {}) {
  const result = await configureImapConnector(env.ctx, { preset: 'fastmail', address: stubImapAddress, appPassword: stubImapPassword, ...input });
  if (result.connector.status !== 'connected') throw new Error(`The stub connect failed: ${result.connector.statusMessage}`);
  return result;
}
