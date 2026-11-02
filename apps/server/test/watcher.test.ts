import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext, createPerson, ensureWorkspace, resetAllData } from '../src/actions/index.js';
import { openDatabase, type Db } from '../src/db.js';
import { EventBus, type DomainEvent } from '../src/events.js';
import { startExternalWatcher } from '../src/watcher.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-watch-'));
  const databasePath = path.join(directory, 'watch.db');
  const main = openDatabase(databasePath);
  const other = openDatabase(databasePath);
  const bus = new EventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const workspace = ensureWorkspace(main);
  const stop = startExternalWatcher(main, bus, 10);
  cleanups.push(() => {
    stop();
    main.close();
    other.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { main, other, bus, events, workspaceId: workspace.id };
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function addPerson(db: Db, bus: EventBus, workspaceId: string, firstName: string) {
  return createPerson(createContext(db, workspaceId, { bus }), { firstName, lastName: 'Tester' });
}

describe('external watcher', () => {
  it('does not replay this process own audit rows when another process commits', async () => {
    const { main, other, bus, events, workspaceId } = setup();
    const own = addPerson(main, bus, workspaceId, 'Own');
    events.length = 0;
    const external = addPerson(other, new EventBus(), workspaceId, 'External');
    await wait(80);
    const relayed = events.filter((event) => event.type === 'record_updated').map((event) => (event as { entityId: string }).entityId);
    expect(relayed).toEqual([external.id]);
    expect(relayed).not.toContain(own.id);
  });

  it('refreshes clients and keeps relaying after the audit table is reset', async () => {
    const { main, other, bus, events, workspaceId } = setup();
    for (let index = 0; index < 5; index += 1) addPerson(main, bus, workspaceId, `Own${index}`);
    events.length = 0;
    resetAllData(other);
    await wait(80);
    expect(events.some((event) => event.type === 'run_updated')).toBe(true);
    expect(events.some((event) => event.type === 'record_updated')).toBe(true);

    const workspace = ensureWorkspace(other);
    events.length = 0;
    const fresh = addPerson(other, new EventBus(), workspace.id, 'Fresh');
    await wait(80);
    const relayed = events.filter((event) => event.type === 'record_updated').map((event) => (event as { entityId: string }).entityId);
    expect(relayed).toContain(fresh.id);
  });
});
