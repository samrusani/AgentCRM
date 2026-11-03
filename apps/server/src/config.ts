export const apiHost = '127.0.0.1';

export function apiPort(): number {
  const raw = process.env.AGENTCRM_PORT;
  const parsed = raw ? Number(raw) : 4720;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 4720;
}

export function stepIntervalMilliseconds(): number {
  const raw = process.env.AGENTCRM_STEP_MS;
  const parsed = raw ? Number(raw) : 1000;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;
}

function positiveIntegerFromEnvironment(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || (parsed === 0 && !allowZero)) return fallback;
  return Math.trunc(parsed);
}

export const defaultApifyBase = 'https://api.apify.com';

export function apifyBaseUrl(): string {
  const raw = process.env.AGENTCRM_APIFY_BASE;
  return (raw && raw.length > 0 ? raw : defaultApifyBase).replace(/\/+$/, '');
}

// How long an Apify run may take before the CRM run gives up. Default 10 minutes.
export function apifyTimeoutMilliseconds(): number {
  return positiveIntegerFromEnvironment('AGENTCRM_APIFY_TIMEOUT_MS', 600_000);
}

// Delay between status checks on a running Apify run. Tests set it to 0.
export function apifyPollMilliseconds(): number {
  return positiveIntegerFromEnvironment('AGENTCRM_APIFY_POLL_MS', 3000, true);
}

export const apifyRequestTimeoutMilliseconds = 10_000;

export const defaultAnthropicBase = 'https://api.anthropic.com';

export function anthropicBaseUrl(): string {
  const raw = process.env.AGENTCRM_ANTHROPIC_BASE;
  return (raw && raw.length > 0 ? raw : defaultAnthropicBase).replace(/\/+$/, '');
}

// The SDK retries rate limits and server errors this many times on its own. Tests set it to 0 to stay fast.
export function anthropicMaxRetries(): number {
  return positiveIntegerFromEnvironment('AGENTCRM_ANTHROPIC_RETRIES', 2, true);
}

export const anthropicChatTimeoutMilliseconds = 30_000;
export const anthropicDraftTimeoutMilliseconds = 60_000;
export const anthropicKeyCheckTimeoutMilliseconds = 10_000;

export const defaultAgentmailBase = 'https://api.agentmail.to/v0';

export function agentmailBaseUrl(): string {
  const raw = process.env.AGENTCRM_AGENTMAIL_BASE;
  return (raw && raw.length > 0 ? raw : defaultAgentmailBase).replace(/\/+$/, '');
}

// Every AgentMail request gives up after this long. Tests shorten it to exercise the unknown outcome path.
export function agentmailRequestTimeoutMilliseconds(): number {
  return positiveIntegerFromEnvironment('AGENTCRM_AGENTMAIL_TIMEOUT_MS', 15_000);
}

// Google endpoints for the Gmail connector. Each base URL can be replaced for tests and for a manual browser check.
export const defaultGoogleAuthBase = 'https://accounts.google.com';
export const defaultGoogleTokenBase = 'https://oauth2.googleapis.com';
export const defaultGmailBase = 'https://gmail.googleapis.com';

function trimmedBase(name: string, fallback: string): string {
  const raw = process.env[name];
  return (raw && raw.length > 0 ? raw : fallback).replace(/\/+$/, '');
}

export function googleAuthBaseUrl(): string {
  return trimmedBase('AGENTCRM_GOOGLE_AUTH_BASE', defaultGoogleAuthBase);
}

export function googleTokenBaseUrl(): string {
  return trimmedBase('AGENTCRM_GOOGLE_TOKEN_BASE', defaultGoogleTokenBase);
}

export function gmailBaseUrl(): string {
  return trimmedBase('AGENTCRM_GMAIL_BASE', defaultGmailBase);
}

// Every Google request gives up after this long. Tests shorten it to exercise the unknown outcome path.
export function gmailRequestTimeoutMilliseconds(): number {
  return positiveIntegerFromEnvironment('AGENTCRM_GMAIL_TIMEOUT_MS', 15_000);
}

// Microsoft endpoints for the Microsoft 365 connector. The Graph base excludes the version path, which the adapter adds.
export const defaultMsLoginBase = 'https://login.microsoftonline.com';
export const defaultGraphBase = 'https://graph.microsoft.com';

export function msLoginBaseUrl(): string {
  return trimmedBase('AGENTCRM_MS_LOGIN_BASE', defaultMsLoginBase);
}

export function graphBaseUrl(): string {
  return trimmedBase('AGENTCRM_GRAPH_BASE', defaultGraphBase);
}

// Every Microsoft request gives up after this long. Tests shorten it to exercise the unknown outcome path.
export function graphRequestTimeoutMilliseconds(): number {
  return positiveIntegerFromEnvironment('AGENTCRM_MS_TIMEOUT_MS', 15_000);
}

// IMAP and SMTP connector. One step (connecting, logging in, one command) gives up after this long. A whole send is
// allowed five steps, and a whole IMAP operation five (connect two, the work two, logout one). Tests shorten it to exercise the unknown outcome path.
export function imapStepTimeoutMilliseconds(): number {
  return positiveIntegerFromEnvironment('AGENTCRM_IMAP_TIMEOUT_MS', 8_000);
}

// AGENTCRM_IMAP_FAKE=1 swaps the real mail servers for an in process fake, for a manual check in the browser.
export function imapFakeEnabled(): boolean {
  return process.env.AGENTCRM_IMAP_FAKE === '1';
}

export const minimumMailPollMilliseconds = 5000;

// How often the inbox is polled. Default 60 seconds, never faster than every 5 seconds.
export function mailPollMilliseconds(): number {
  return Math.max(minimumMailPollMilliseconds, positiveIntegerFromEnvironment('AGENTCRM_MAIL_POLL_MS', 60_000));
}

// How often the follow-up lane walks its rules. It follows the mail poll cadence unless AGENTCRM_FOLLOWUP_TICK_MS
// says otherwise (tests use a small number, and 0 means every worker tick).
export function followupTickMilliseconds(): number {
  return positiveIntegerFromEnvironment('AGENTCRM_FOLLOWUP_TICK_MS', mailPollMilliseconds(), true);
}

export const defaultMailReconcileDelays: readonly number[] = [30_000, 120_000, 600_000];

// Gmail's check is read only and costs nothing to repeat, so it keeps looking for roughly a day before it stops and
// asks a person to check the sent mail: 30 seconds, 2 minutes, 10 minutes, 1 hour, 6 hours, 22 hours. Microsoft uses
// the same schedule, because its check reads one draft and can only send that same draft again. IMAP uses it too: its
// check is a read only search of the Sent mailbox, and nothing is ever sent again.
export const defaultGmailReconcileDelays: readonly number[] = [30_000, 120_000, 600_000, 3_600_000, 21_600_000, 79_200_000];

// Waits before each reconciliation attempt for a send whose outcome is unknown. AgentMail: 30 seconds, 2 minutes,
// 10 minutes. Gmail has the longer schedule above.
// AGENTCRM_MAIL_RECONCILE_MS replaces them with one number (used for every attempt) or a comma list.
export function mailReconcileDelays(provider: 'agentmail' | 'gmail' | 'microsoft' | 'imap' = 'agentmail'): readonly number[] {
  const defaults = provider === 'agentmail' ? defaultMailReconcileDelays : defaultGmailReconcileDelays;
  const raw = process.env.AGENTCRM_MAIL_RECONCILE_MS;
  if (raw === undefined || raw.trim() === '') return defaults;
  const parsed = raw.split(',').map((part) => Number(part.trim()));
  if (parsed.some((value) => !Number.isFinite(value) || value < 0)) return defaults;
  const delays = parsed.map((value) => Math.trunc(value));
  return delays.length === 1 ? defaults.map(() => delays[0]!) : delays;
}

export const dailySendCap = 50;
export const maxIntentsPerApproval = 25;

export const workerTickMilliseconds = 300;
export const serverVersion = '0.1.0';

// Model providers other than Anthropic. Each base URL can be replaced for tests.
export const modelKeyCheckTimeoutMilliseconds = 15_000;
export const modelChatTimeoutMilliseconds = 30_000;
export const modelDraftTimeoutMilliseconds = 60_000;
export const defaultOllamaBase = 'http://127.0.0.1:11434';

export function providerBaseUrl(environmentName: string, fallback: string): string {
  const raw = process.env[environmentName];
  return (raw && raw.length > 0 ? raw : fallback).replace(/\/+$/, '');
}
