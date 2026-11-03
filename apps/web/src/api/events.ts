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
  run_updated: ['today', 'runs', 'run', 'approvals', 'import', 'connectors', 'model-provider', 'people', 'person', 'qualification'],
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
    'tasks',
    'activities',
    'search',
    'qualification',
    ...MAIL_KEYS,
  ],
  // Rule changes show in the Follow-ups section, the Outbox markers, and a person sheet that shows that person's rule.
  followup_updated: ['followup-rules', 'person', 'send-intents', 'mail-summary'],
};

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
        source.addEventListener(name, () => invalidateFor(queryClient, name));
      }

      // Accept servers that send unnamed messages carrying a type field.
      source.onmessage = (message: MessageEvent<string>) => {
        try {
          const data = JSON.parse(message.data) as { type?: string; event?: string };
          const name = (data.type ?? data.event) as ServerEventName | undefined;
          if (name && EVENT_NAMES.includes(name)) invalidateFor(queryClient, name);
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
