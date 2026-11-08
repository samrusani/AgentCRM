import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { OrganizationSheet, PersonSheet } from '../../src/screens/RecordSheets';
import { useServerEvents } from '../../src/api/events';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));

const SENTENCE = 'This record was deleted, usually because it was merged into another record.';
let failure: { status: number; code: string; message: string };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  failure = { status: 404, code: 'not_found', message: 'Not found.' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/people/person-1' || url.pathname === '/api/organizations/org-1') {
        return json(failure.status, { error: { code: failure.code, message: failure.message } });
      }
      return json(200, { items: [], nextCursor: null });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSheet(kind: 'person' | 'organization') {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        {kind === 'person' ? (
          <PersonSheet id="person-1" onClose={onClose} onOpenOrganization={() => {}} />
        ) : (
          <OrganizationSheet id="org-1" onClose={onClose} onOpenPerson={() => {}} />
        )}
      </Router>
    </QueryClientProvider>,
  );
  return { user, onClose };
}

describe.each(['person', 'organization'] as const)('%s sheet deleted state', (kind) => {
  it('shows the deleted sentence and a Close button, with no retry, on not_found', async () => {
    const { user, onClose } = renderSheet(kind);
    expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the error state with Retry for any other error', async () => {
    failure = { status: 500, code: 'internal', message: 'Something broke.' };
    renderSheet(kind);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2;
  readyState = 1;
  listeners = new Map<string, ((message: MessageEvent<string>) => void)[]>();
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (message: MessageEvent<string>) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {}
  dispatch(name: string, data: string) {
    for (const listener of this.listeners.get(name) ?? []) listener({ data } as MessageEvent<string>);
  }
}

describe('record_deleted event handling', () => {
  let client: QueryClient;
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    client = new QueryClient();
    client.setQueryData(['person', 'per_gone'], { id: 'per_gone' });
    client.setQueryData(['person', 'per_keep'], { id: 'per_keep' });
    client.setQueryData(['organization', 'org_gone'], { id: 'org_gone' });
    client.setQueryData(['organization', 'org_keep'], { id: 'org_keep' });
    client.setQueryData(['duplicates'], { pairs: [] });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    renderHook(() => useServerEvents(), { wrapper });
  });

  it('removes the exact person cache and invalidates the duplicates list', () => {
    FakeEventSource.instances[0].dispatch('record_deleted', JSON.stringify({ type: 'record_deleted', entityType: 'person', entityId: 'per_gone' }));
    expect(client.getQueryData(['person', 'per_gone'])).toBeUndefined();
    expect(client.getQueryData(['person', 'per_keep'])).toBeDefined();
    expect(client.getQueryData(['organization', 'org_gone'])).toBeDefined();
    expect(client.getQueryState(['duplicates'])?.isInvalidated).toBe(true);
  });

  it('removes the exact organization cache', () => {
    FakeEventSource.instances[0].dispatch('record_deleted', JSON.stringify({ entityType: 'organization', entityId: 'org_gone' }));
    expect(client.getQueryData(['organization', 'org_gone'])).toBeUndefined();
    expect(client.getQueryData(['organization', 'org_keep'])).toBeDefined();
    expect(client.getQueryData(['person', 'per_gone'])).toBeDefined();
  });

  it('still invalidates when the payload cannot be parsed', () => {
    FakeEventSource.instances[0].dispatch('record_deleted', 'not json');
    expect(client.getQueryData(['person', 'per_gone'])).toBeDefined();
    expect(client.getQueryState(['duplicates'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['person', 'per_keep'])?.isInvalidated).toBe(true);
  });

  it('does not touch duplicates for record_updated', () => {
    FakeEventSource.instances[0].dispatch('record_updated', JSON.stringify({ entityType: 'person', entityId: 'per_gone' }));
    expect(client.getQueryState(['duplicates'])?.isInvalidated).toBe(false);
    expect(client.getQueryData(['person', 'per_gone'])).toBeDefined();
  });
});
