export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked or full. State then lasts for the session only.
  }
}

export function readNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = readStorage(key);
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function readBoolean(key: string, fallback: boolean): boolean {
  const raw = readStorage(key);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}
