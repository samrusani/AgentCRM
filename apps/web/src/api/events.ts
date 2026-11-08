import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ServerEventName } from './types';

type Connection = 'connecting' | 'open' | 'down';

let connection: Connection = 'connecting';
const listeners = new Set<() => void>();

function setConnection(next: Connection) {
  if (connection === next) return;
  connection = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEventConnection(): Connection {
  return useSyncExternalStore(subscribe, () => connection, () => 'connecting' as Connection);
}

// Send intents, the mail summary, and suppressions change with run, approval, and record events.
const MAIL_KEYS = ['send-intents', 'mail-summary', 'suppressions'];

const KEYS_BY_EVENT: Record<ServerEventName, string[]> = {
  run_updated: ['today', 'runs', 'run', 'approvals', 'import', 'connectors', 'model-provider', 'people', 'person', 'qualification', 'enrichment'],
  approval_updated: ['today', 'approvals', 'runs', 'run', 'import', ...MAIL_KEYS],
  record_updated: [
    'today',
    'import',
    'connectors',
    'model-provider',
    'people',
    'person',
    'organizations',
    'organization',
    'opportunities',
    'pipelines',
    // List and membership changes emit record_updated for the list; the tables and person sheets show them.
    'lists',
    // Definition changes emit record_updated with entityType attribute_def; Settings lists them and sheets show them.
    'attributes',
    // Rule changes and deletion-driven disables emit record_updated with entityType automation; Settings lists them.
    'automations',
    // Sequence changes emit record_updated with entityType sequence; Settings and the prepare editor list them.
    'sequences',
    // View changes emit record_updated with entityType view; the Views select on Leads, Relationships, and Pipeline lists them.
    'views',
    // The Delete action on the Pipeline page reads deal counts per pipeline.
    'stage-counts',
    'tasks',
    'activities',
    'search',
    'qualification',
    'enrichment',
    // The token routes emit record_updated with entityType capture_settings, so a rotation made
    // outside this tab reaches the Settings card.
    'capture-settings',
    // The imports setting emits record_updated with entityType import_settings, so a toggle made
    // in another tab reaches this one instead of going stale.
    'import-settings',
    ...MAIL_KEYS,
  ],
  // Rule changes show in the Follow-ups section, the Outbox markers, and a person sheet that shows that person's rule.
  followup_updated: ['followup-rules', 'person', 'send-intents', 'mail-summary'],
  // Filled in below: the same keys as record_updated plus the Duplicates lists.
  record_deleted: [],
};
// A merge in another tab also changes the Duplicates lists.
KEYS_BY_EVENT.record_deleted = [...KEYS_BY_EVENT.record_updated, 'duplicates'];

// A deleted record's own INACTIVE detail caches are removed and the ACTIVE ones invalidated. Removing an active
// entry would orphan the mounted observer and nothing would refetch; the split drops background copies of a dead id
// while an open sheet's query refetches once and gets the 404 that shows the deleted state.
function removeDeleted(queryClient: QueryClient, data: unknown) {
  if (typeof data !== 'object' || data === null) return;
  const { entityType, entityId } = data as { entityType?: unknown; entityId?: unknown };
  if (typeof entityId !== 'string' || entityId === '') return;
  const keys =
    entityType === 'person'
      ? [['person', entityId], ['enrichment', entityId]]
      : entityType === 'organization'
        ? [['organization', entityId], ['enrichment', 'organization', entityId]]
        : [];
  // The broad invalidation that follows covers every active entry (person, organization, and enrichment prefixes
  // are all in the record_deleted key list), so only the inactive copies are dropped here. A second per-id
  // invalidate would stack a second refetch on the open sheet.
  for (const queryKey of keys) {
    queryClient.removeQueries({ queryKey, type: 'inactive' });
  }
}

export function handleServerEvent(queryClient: QueryClient, name: ServerEventName, data?: unknown) {
  if (name === 'record_deleted') removeDeleted(queryClient, data);
  invalidateFor(queryClient, name);
}

function invalidateFor(queryClient: QueryClient, name: ServerEventName) {
  for (const key of KEYS_BY_EVENT[name]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

function invalidateEverything(queryClient: QueryClient) {
  void queryClient.invalidateQueries();
}

const EVENT_NAMES = Object.keys(KEYS_BY_EVENT) as ServerEventName[];
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

// EventSource retries on its own after a dropped connection. When the server
// answers with an error status the browser closes the stream for good, so this
// hook reopens it with backoff. After any gap, every cache is refetched because
// events may have been missed.
export function useServerEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let attempt = 0;
    let disposed = false;
    let hadGap = false;

    const open = () => {
      if (disposed) return;
      setConnection('connecting');
      source = new EventSource('/api/events');

      source.onopen = () => {
        attempt = 0;
        setConnection('open');
        if (hadGap) invalidateEverything(queryClient);
        hadGap = false;
      };

      for (const name of EVENT_NAMES) {
        source.addEventListener(name, (message) => {
          let data: unknown;
          if (name === 'record_deleted') {
            try {
              data = JSON.parse((message as MessageEvent<string>).data);
            } catch {
              data = undefined;
            }
          }
          handleServerEvent(queryClient, name, data);
        });
      }

      // Accept servers that send unnamed messages carrying a type field.
      source.onmessage = (message: MessageEvent<string>) => {
        try {
          const data = JSON.parse(message.data) as { type?: string; event?: string };
          const name = (data.type ?? data.event) as ServerEventName | undefined;
          if (name && EVENT_NAMES.includes(name)) handleServerEvent(queryClient, name, data);
        } catch {
          // Ignore keep alive comments and malformed payloads.
        }
      };

      source.onerror = () => {
        hadGap = true;
        setConnection('down');
        if (source && source.readyState === EventSource.CLOSED) {
          source.close();
          source = null;
          const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
          attempt += 1;
          retryTimer = window.setTimeout(open, delay);
        }
      };
    };

    open();

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [queryClient]);
}
