import { randomBytes } from 'node:crypto';

export type IdPrefix =
  | 'wsp'
  | 'per'
  | 'org'
  | 'pip'
  | 'stg'
  | 'opp'
  | 'act'
  | 'tsk'
  | 'clm'
  | 'run'
  | 'stp'
  | 'apr'
  | 'job'
  | 'aud'
  | 'evt';

export function randomId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

// Small seeded generator so the seed script produces the same ids on every run.
export function seededIdFactory(seed: number): (prefix: IdPrefix) => string {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (prefix) => {
    let hex = '';
    for (let index = 0; index < 12; index += 1) hex += Math.floor(next() * 16).toString(16);
    return `${prefix}_${hex}`;
  };
}
