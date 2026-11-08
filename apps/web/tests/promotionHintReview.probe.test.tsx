// Adversarial probes for the mailbox promotion hint. KILLS = attack defeated; CONFIRMS = violation demonstrated.
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportReviewBody } from '../src/components/importReview';
import { parseImportReviewPayload } from '../src/lib/imports';
import { Router } from './helpers';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const rule = (id: string, enabled = true, triggerKind = 'person_promoted') => ({
  id, name: id, triggerKind, triggerConfig: {}, actionConfig: { taskTitle: 't', dueInDays: 1 }, enabled, disabledReason: null, firedCount: 0, version: 1,
});
const base = { batchId: 'b', counts: { fetched: 5, staged: 5, duplicates: 0, invalid: 0 }, sample: [] };
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));

function install(handler: () => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    return url.pathname === '/api/automations' ? handler() : json({}, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
function mount(cards: unknown[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Router>
        {cards.map((payload, i) => (
          <ImportReviewBody key={i} approval={{ id: `a${i}`, runId: 'r' } as never} review={parseImportReviewPayload(payload)!} />
        ))}
      </Router>
    </QueryClientProvider>,
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('promotion hint probes', () => {
  it('KILLS: a non-mailbox (CSV) payload that carries willPromote shows no hint and never fetches automations', async () => {
    const fn = install(() => json({ items: [rule('a')], nextCursor: null }));
    const { container } = mount([{ ...base, fileName: 'x.csv', willPromote: 4 }]);
    await settle();
    expect(container.textContent).not.toContain('Accepting promotes');
    expect(fn).not.toHaveBeenCalled();
  });

  it('KILLS: automations request failing (500) is silent: no hint, no error text, no crash', async () => {
    install(() => json({ error: { code: 'x', message: 'boom' } }, 500));
    const { container } = mount([{ ...base, sinceDays: 7, willPromote: 4 }]);
    await settle();
    expect(container.textContent).not.toContain('Accepting promotes');
    expect(container.textContent).not.toContain('boom');
  });

  it('KILLS: ten mailbox cards share one automations request', async () => {
    const fn = install(() => json({ items: [rule('a')], nextCursor: null }));
    const { container } = mount(Array.from({ length: 10 }, () => ({ ...base, sinceDays: 7, willPromote: 2 })));
    await settle();
    expect((container.textContent!.match(/Accepting promotes/g) ?? []).length).toBe(10);
    expect(fn.mock.calls.length).toBe(1);
  });

  it('KILLS: numbers use tabular numeral spans and large counts are grouped', async () => {
    install(() => json({ items: [rule('a'), rule('b')], nextCursor: null }));
    const { container } = mount([{ ...base, sinceDays: null, willPromote: 1500 }]);
    await settle();
    const nums = [...container.querySelectorAll('p.muted span.num')].map((n) => n.textContent);
    expect(nums).toEqual(expect.arrayContaining(['1,500', '3,000', '2']));
    expect(container.textContent).toContain('Up to 3,000 tasks will be created by 2 automation rules.');
  });

  it('KILLS: hint sits between the sample table and the buttons region (before the duplicates note)', async () => {
    install(() => json({ items: [rule('a')], nextCursor: null }));
    const { container } = mount([{ ...base, sinceDays: 7, willPromote: 2 }]);
    await settle();
    const text = container.textContent!;
    expect(text.indexOf('Accepting promotes')).toBeGreaterThan(-1);
    expect(text.indexOf('Accepting promotes')).toBeLessThan(text.indexOf('Duplicates and invalid rows'));
  });

  it('KILLS: negative, NaN and non-numeric willPromote parse to null (no hint)', () => {
    for (const bad of [-3, 'abc', NaN, null, '']) {
      expect(parseImportReviewPayload({ ...base, sinceDays: 7, willPromote: bad })!.willPromote).toBeNull();
    }
  });

  it('ACCEPTED: a fractional willPromote (server never emits one) would render "2.5 people"', async () => {
    install(() => json({ items: [rule('a')], nextCursor: null }));
    const { container } = mount([{ ...base, sinceDays: 7, willPromote: 2.5 }]);
    await settle();
    expect(container.textContent).toContain('promotes up to 2.5 people');
  });
});
