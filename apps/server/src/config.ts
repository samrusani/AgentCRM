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

export const workerTickMilliseconds = 300;
export const serverVersion = '0.1.0';
