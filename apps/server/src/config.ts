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

export const workerTickMilliseconds = 300;
export const serverVersion = '0.1.0';
