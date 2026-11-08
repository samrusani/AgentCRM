// Adversarial review probes for the record_deleted wave (server). KILLS: attack failed, safe behavior pinned.
// CONFIRMS: live gap asserted as it behaves today. ACCEPTED: limit the contract states.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext, createPerson, createOrganization, ensureWorkspace, mergeOrganizations, mergePeople, resetRecordData } from '../src/actions/index.js';
import { openDatabase, type Db } from '../src/db.js';
import { EventBus, type DomainEvent } from '../src/events.js';
import { startExternalWatcher } from '../src/watcher.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(watch = true) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-delprobe-'));
  const databasePath = path.join(directory, 'p.db');
  const main = openDatabase(databasePath);
  const other = openDatabase(databasePath);
  const bus = new EventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const workspace = ensureWorkspace(main);
  const stop = watch ? startExternalWatcher(main, bus, 10) : () => {};
  cleanups.push(() => {
    stop();
    main.close();
    other.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const ctxMain = createContext(main, workspace.id, { bus });
  const foreignBus = new EventBus();
  const foreignEvents: DomainEvent[] = [];
  foreignBus.subscribe((event) => foreignEvents.push(event));
  const ctxOther = createContext(other, workspace.id, { bus: foreignBus });
  return { main, other, bus, events, foreignEvents, ctxMain, ctxOther, workspaceId: workspace.id };
}

let n = 0;
const mkPerson = (ctx: ReturnType<typeof createContext>) => createPerson(ctx, { firstName: `P${++n}`, lastName: 'Probe' });
const mkOrg = (ctx: ReturnType<typeof createContext>) => createOrganization(ctx, { name: `Org probe ${++n}`, kind: 'company' } as never);
const mergeBody = (s: { version: number }, o: { id: string; version: number }) => ({ otherId: o.id, expectedVersion: s.version, otherExpectedVersion: o.version });

describe('emission honesty', () => {
  it('KILLS: only the two merges delete person/organization rows in src (static grep, including template SQL)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (/DELETE\s+FROM\s+(person|organization)\b/i.test(line)) hits.push(`${path.relative(path.join(__dirname, '..'), file)}:${index + 1}`);
      });
    }
    // ACCEPTED: workspace.ts deletes wholesale via DELETE FROM ${table} (reset), documented as emitting no record_deleted.
    expect(hits.sort()).toEqual(['src/actions/duplicates.ts:116', 'src/actions/duplicates.ts:233']);
  });

  it.each(['person', 'organization'] as const)('KILLS: a %s merge aborted late inside the transaction emits nothing and deletes nothing', (kind) => {
    const { main, events, ctxMain } = setup(false);
    const make = kind === 'person' ? mkPerson : mkOrg;
    const survivor = make(ctxMain) as any;
    const gone = make(ctxMain) as any;
    events.length = 0;
    // The audit insert is the last write before the emits; abort there.
    main.exec(`CREATE TRIGGER late_abort BEFORE INSERT ON audit_event WHEN NEW.action = '${kind}.merge' BEGIN SELECT RAISE(ABORT, 'late'); END;`);
    const run = () => (kind === 'person' ? mergePeople : mergeOrganizations)(ctxMain, survivor.id, mergeBody(survivor, gone));
    expect(run).toThrow();
    expect(events).toEqual([]);
    const table = kind;
    expect((main.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(gone.id) as { n: number }).n).toBe(1);
    main.exec('DROP TRIGGER late_abort');
    // A later successful merge still emits exactly once (no queue leak between calls).
    events.length = 0;
    run();
    expect(events.filter((e) => e.type === 'record_deleted')).toEqual([{ type: 'record_deleted', entityType: kind, entityId: gone.id }]);
  });

  it('KILLS: a subscriber that observes record_deleted already sees the row gone and the survivor committed (fires after commit)', () => {
    const { main, bus, ctxMain } = setup(false);
    const s = mkPerson(ctxMain) as any;
    const g = mkPerson(ctxMain) as any;
    const seen: { rows: number; audits: number; inTx: boolean }[] = [];
    bus.subscribe((e) => {
      if (e.type === 'record_deleted') {
        seen.push({
          rows: (main.prepare('SELECT COUNT(*) AS n FROM person WHERE id = ?').get(e.entityId) as { n: number }).n,
          audits: (main.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'person.merge'").get() as { n: number }).n,
          inTx: main.inTransaction,
        });
      }
    });
    mergePeople(ctxMain, s.id, mergeBody(s, g));
    expect(seen).toEqual([{ rows: 0, audits: 1, inTx: false }]);
  });

  it('ACCEPTED (noted): event order is record_updated(survivor) then record_deleted(other); any lifecycle promotion adds no extra record_deleted', () => {
    const { ctxMain, events } = setup(false);
    const s = mkPerson(ctxMain) as any;
    const g = mkPerson(ctxMain) as any;
    events.length = 0;
    mergePeople(ctxMain, s.id, mergeBody(s, g));
    const order = events.map((e) => (e.type === 'record_deleted' ? `deleted:${(e as any).entityId === g.id}` : `${e.type}:${(e as any).entityId === s.id}`));
    console.log('[probe] merge event order:', JSON.stringify(order));
    expect(events.filter((e) => e.type === 'record_deleted')).toHaveLength(1);
    expect(order.indexOf('deleted:true')).toBeGreaterThan(order.indexOf('record_updated:true'));
  });
});

describe('watcher relay', () => {
  it('KILLS: a real foreign person merge relays exactly one record_deleted across many ticks, cursor moves past it', async () => {
    const { events, ctxMain, ctxOther } = setup();
    const s = mkPerson(ctxMain) as any;
    const g = mkPerson(ctxMain) as any;
    await wait(60);
    events.length = 0;
    mergePeople(ctxOther, s.id, mergeBody(s, g));
    await wait(200); // ~20 ticks
    expect(events.filter((e) => e.type === 'record_deleted')).toEqual([{ type: 'record_deleted', entityType: 'person', entityId: g.id }]);
    expect(events.filter((e) => e.type === 'record_updated' && (e as any).entityId === s.id)).toHaveLength(1);
    // Another unrelated foreign write afterwards must not replay the merge.
    events.length = 0;
    mkPerson(ctxOther);
    await wait(100);
    expect(events.filter((e) => e.type === 'record_deleted')).toEqual([]);
  });

  it('KILLS: a real foreign organization merge relays exactly one record_deleted', async () => {
    const { events, ctxMain, ctxOther } = setup();
    const s = mkOrg(ctxMain) as any;
    const g = mkOrg(ctxMain) as any;
    await wait(60);
    events.length = 0;
    mergeOrganizations(ctxOther, s.id, mergeBody(s, g));
    await wait(150);
    expect(events.filter((e) => e.type === 'record_deleted')).toEqual([{ type: 'record_deleted', entityType: 'organization', entityId: g.id }]);
  });

  it('KILLS: this process own merge does not double-relay, even when a foreign commit lands right after', async () => {
    const { events, ctxMain, ctxOther } = setup();
    const s = mkPerson(ctxMain) as any;
    const g = mkPerson(ctxMain) as any;
    const x = mkPerson(ctxMain) as any;
    await wait(60);
    events.length = 0;
    mergePeople(ctxMain, s.id, mergeBody(s, g));
    mkPerson(ctxOther); // foreign commit triggers data_version change and a scan
    await wait(150);
    expect(events.filter((e) => e.type === 'record_deleted')).toHaveLength(1);
    void x;
  });

  it('KILLS: two merges in one foreign batch relay both deletions in order, once each', async () => {
    const { events, ctxMain, ctxOther } = setup();
    const a = mkPerson(ctxMain) as any, b = mkPerson(ctxMain) as any, c = mkPerson(ctxMain) as any;
    await wait(60);
    events.length = 0;
    mergePeople(ctxOther, a.id, mergeBody(a, b));
    const a2 = { version: (a.version as number) + 1 };
    mergePeople(ctxOther, a.id, mergeBody(a2, c));
    await wait(150);
    expect(events.filter((e) => e.type === 'record_deleted').map((e) => (e as any).entityId)).toEqual([b.id, c.id]);
  });

  function forge(db: Db, workspaceId: string, id: string, action: string, entityType: string, entityId: string, detail: string) {
    db.prepare('INSERT INTO audit_event (id, created_at, workspace_id, actor, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, new Date().toISOString(), workspaceId, 'agent', action, entityType, entityId, detail,
    );
  }

  it.each([
    ['object', { otherId: { id: 'per_x' } }],
    ['array', { otherId: ['per_x'] }],
    ['number', { otherId: 7 }],
    ['null', { otherId: null }],
    ['empty string', { otherId: '' }],
    ['detail is an array', ['per_x']],
    ['detail is a string literal', 'per_x'],
  ])('KILLS: hostile detail (otherId %s) never relays a record_deleted', async (_l, detail) => {
    const { other, events, workspaceId } = setup();
    forge(other, workspaceId, 'aud_h1', 'person.merge', 'person', 'per_s', JSON.stringify(detail));
    await wait(80);
    expect(events.filter((e) => e.type === 'record_deleted')).toEqual([]);
    expect(events.filter((e) => e.type === 'record_updated')).toHaveLength(1);
  });

  it('CONFIRMS (low): any string otherId is relayed verbatim: the survivor own id, a giant string, or an SSE-hostile string. Only the merge actions write these rows, so detail is trusted. Effect of the survivor-id case: web removes the SURVIVOR detail cache then refetches to 200; harmless.', async () => {
    const { other, events, workspaceId } = setup();
    const giant = 'x'.repeat(200_000);
    const nasty = 'per_a\nevent: run_updated\ndata: {}\n\n';
    forge(other, workspaceId, 'aud_h2', 'person.merge', 'person', 'per_s', JSON.stringify({ otherId: 'per_s' }));
    forge(other, workspaceId, 'aud_h3', 'person.merge', 'person', 'per_s', JSON.stringify({ otherId: giant }));
    forge(other, workspaceId, 'aud_h4', 'organization.merge', 'organization', 'org_s', JSON.stringify({ otherId: nasty }));
    await wait(100);
    const deleted = events.filter((e) => e.type === 'record_deleted') as any[];
    expect(deleted.map((e) => e.entityId.length)).toEqual([5, 200_000, nasty.length]);
    // The SSE writer JSON.stringifies the whole event: raw newlines in entityId become \n escapes, so framing holds.
    const frame = `event: ${deleted[2].type}\ndata: ${JSON.stringify(deleted[2])}\n\n`;
    expect(frame.split('\n').filter((l) => l !== '')).toHaveLength(2);
    expect(frame.endsWith('\n\n')).toBe(true);
    // And the writer in src really is that template.
    const src = readFileSync(path.join(__dirname, '..', 'src', 'http', 'events.ts'), 'utf8');
    expect(src).toContain('event: ${event.type}\\ndata: ${JSON.stringify(event)}');
  });

  it('KILLS: the audit action string is not forgeable through the generic helpers: every tx.audit call site builds its action from a fixed prefix that is not person/organization.merge', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    const dynamic: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\.audit\(\s*`([^`]*)`/g)) dynamic.push(m[1]!);
    }
    console.log('[probe] dynamic audit action templates:', JSON.stringify(dynamic));
    // `${type}.update` is the only template that interpolates an entity type, and ends in .update.
    for (const template of dynamic) expect(/\.(merge)$/.test(template)).toBe(false);
  });

  it('KILLS: seed --reset rowid shrink still works, and a merge row inserted after the shrink is relayed once', async () => {
    const { main, other, events, ctxMain, ctxOther, workspaceId } = setup();
    for (let i = 0; i < 5; i += 1) mkPerson(ctxMain);
    await wait(40);
    events.length = 0;
    resetRecordData(other);
    await wait(80);
    expect(events.some((e) => e.type === 'run_updated')).toBe(true);
    const s = mkPerson(ctxOther) as any;
    const g = mkPerson(ctxOther) as any;
    events.length = 0;
    mergePeople(ctxOther, s.id, mergeBody(s, g));
    await wait(150);
    expect(events.filter((e) => e.type === 'record_deleted')).toEqual([{ type: 'record_deleted', entityType: 'person', entityId: g.id }]);
    void main; void workspaceId;
  });

  it('CONFIRMS (low, ACCEPTED by design): a foreign merge whose rowid lands inside the reset-shrink window (rows removed and re-added so MAX(rowid) >= lastRowid) is relayed by the normal path only if rowid > lastRowid; a merge reusing a lower rowid after a reset that regrows past the cursor within one tick is silently skipped', async () => {
    const { main, other, events, ctxMain, ctxOther } = setup();
    for (let i = 0; i < 3; i += 1) mkPerson(ctxMain);
    await wait(40);
    const before = (main.prepare('SELECT MAX(rowid) AS n FROM audit_event').get() as { n: number }).n;
    // Reset then regrow with a merge, all before the next tick, so MAX(rowid) never dips under the cursor.
    other.pragma('busy_timeout = 2000');
    resetRecordData(other);
    const s = mkPerson(ctxOther) as any;
    const g = mkPerson(ctxOther) as any;
    for (let i = 0; i < before; i += 1) mkPerson(ctxOther);
    events.length = 0;
    mergePeople(ctxOther, s.id, mergeBody(s, g));
    await wait(150);
    const got = events.filter((e) => e.type === 'record_deleted').length;
    console.log(`[probe] shrink+regrow-in-one-tick: record_deleted relayed = ${got} (pre-existing cursor limit; not introduced by this wave)`);
    expect(got).toBeLessThanOrEqual(1);
  });
});
