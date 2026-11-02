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

export const minimumMailPollMilliseconds = 5000;

// How often the inbox is polled. Default 60 seconds, never faster than every 5 seconds.
export function mailPollMilliseconds(): number {
  return Math.max(minimumMailPollMilliseconds, positiveIntegerFromEnvironment('AGENTCRM_MAIL_POLL_MS', 60_000));
}

export const defaultMailReconcileDelays: readonly number[] = [30_000, 120_000, 600_000];

// Waits before each reconciliation attempt for a send whose outcome is unknown: 30 seconds, 2 minutes, 10 minutes.
// AGENTCRM_MAIL_RECONCILE_MS replaces them with one number (used for every attempt) or a comma list.
export function mailReconcileDelays(): readonly number[] {
  const raw = process.env.AGENTCRM_MAIL_RECONCILE_MS;
  if (raw === undefined || raw.trim() === '') return defaultMailReconcileDelays;
  const parsed = raw.split(',').map((part) => Number(part.trim()));
  if (parsed.some((value) => !Number.isFinite(value) || value < 0)) return defaultMailReconcileDelays;
  const delays = parsed.map((value) => Math.trunc(value));
  return delays.length === 1 ? [delays[0]!, delays[0]!, delays[0]!] : delays;
}

export const dailySendCap = 50;
export const maxIntentsPerApproval = 25;

export const workerTickMilliseconds = 300;
export const serverVersion = '0.1.0';
