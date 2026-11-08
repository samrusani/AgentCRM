import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportReviewBody } from '../../src/components/importReview';
import { parseImportReviewPayload } from '../../src/lib/imports';
import { Router } from '../helpers';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const rule = (id: string, triggerKind: string, enabled: boolean) => ({
  id,
  name: id,
  triggerKind,
  triggerConfig: {},
  actionConfig: { taskTitle: 'Follow up', dueInDays: 2 },
  enabled,
  disabledReason: null,
  firedCount: 0,
  version: 1,
});

let release: (() => void) | null = null;

function installAutomations(items: unknown[], options: { hold?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/automations') {
        if (options.hold) await new Promise<void>((resolve) => (release = resolve));
        return json({ items, nextCursor: null });
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function renderReview(willPromote: number | undefined) {
  const review = parseImportReviewPayload({
    batchId: 'b',
    sinceDays: null,
    counts: { fetched: 5, staged: 5, duplicates: 0, invalid: 0 },
    ...(willPromote === undefined ? {} : { willPromote }),
    sample: [{ email: 'x@y.example', name: 'X', inbound: 1, outbound: 0, lastSeenAt: '2026-01-01T00:00:00.000Z' }],
  })!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Router>
        <ImportReviewBody approval={{ id: 'a', runId: 'r' } as never} review={review} />
      </Router>
    </QueryClientProvider>,
  );
}

const fetchedAutomations = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0;

afterEach(() => {
  release = null;
  vi.unstubAllGlobals();
});

describe('mailbox import review promotion hint', () => {
  it('parses willPromote, and null when the payload predates it', () => {
    const base = { batchId: 'b', sinceDays: null, counts: { fetched: 1, staged: 1, duplicates: 0, invalid: 0 }, sample: [] };
    expect(parseImportReviewPayload({ ...base, willPromote: 3 })!.willPromote).toBe(3);
    expect(parseImportReviewPayload(base)!.willPromote).toBeNull();
  });

  it('shows the exact sentence, counting only enabled person_promoted rules', async () => {
    installAutomations([
      rule('a', 'person_promoted', true),
      rule('b', 'person_promoted', true),
      rule('c', 'person_promoted', false),
      rule('d', 'stage_entered', true),
    ]);
    const { container } = renderReview(3);
    await waitFor(() =>
      expect(container.textContent).toContain(
        'Accepting promotes up to 3 people who have written to you. Up to 6 tasks will be created by 2 automation rules.',
      ),
    );
    expect(container.querySelectorAll('.num').length).toBeGreaterThanOrEqual(3);
  });

  it('uses singular forms at one', async () => {
    installAutomations([rule('a', 'person_promoted', true)]);
    const { container } = renderReview(1);
    await waitFor(() =>
      expect(container.textContent).toContain(
        'Accepting promotes up to 1 person who has written to you. Up to 1 task will be created by 1 automation rule.',
      ),
    );
  });

  it('shows no hint for an old payload without willPromote', async () => {
    installAutomations([rule('a', 'person_promoted', true)]);
    const { container } = renderReview(undefined);
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(container.textContent).not.toContain('Accepting promotes');
    expect(fetchedAutomations()).toBe(false);
  });

  it('shows no hint when willPromote is 0', async () => {
    installAutomations([rule('a', 'person_promoted', true)]);
    const { container } = renderReview(0);
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(container.textContent).not.toContain('Accepting promotes');
  });

  it('shows no hint when no enabled person_promoted rule exists', async () => {
    installAutomations([rule('c', 'person_promoted', false), rule('d', 'stage_entered', true)]);
    const { container } = renderReview(3);
    await waitFor(() => expect(fetchedAutomations()).toBe(true));
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(container.textContent).not.toContain('Accepting promotes');
  });

  it('shows nothing while the automations are loading', async () => {
    installAutomations([rule('a', 'person_promoted', true)], { hold: true });
    const { container } = renderReview(3);
    await waitFor(() => expect(fetchedAutomations()).toBe(true));
    expect(container.textContent).not.toContain('Accepting promotes');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    release?.();
    await waitFor(() => expect(container.textContent).toContain('Accepting promotes up to 3 people'));
  });
});
