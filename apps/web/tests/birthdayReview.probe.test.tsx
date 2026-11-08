// Adversarial probes for the birthday Today card and format helpers. KILLS / CONFIRMS / ACCEPTED as in the server probes.
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { birthdayProximity, formatBirthday } from '../src/lib/format';
import { Today } from '../src/screens/Today';
import { Router } from './helpers';

vi.mock('../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../src/api/events', () => ({ useServerEvents: () => {}, useEventConnection: () => 'open' }));

let birthdays: unknown[] = [];
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const body = url.pathname === '/api/today' ? { tasksDue: [], approvalsPending: [], runsActive: [], counts: {}, birthdays } : url.pathname.includes('summary') ? { counts: {}, repliesNeedingAttention: { count: 0, items: [] } } : { items: [], nextCursor: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('Today birthdays card', () => {
  it('KILLS: hostile names render as text, the link targets the person sheet route, and the count matches the rows', async () => {
    const hostile = '<img src=x onerror=alert(1)> ‮evil';
    birthdays = [
      { personId: 'per_a"><b>', name: hostile, date: '2026-11-12', turns: 3 },
      { personId: 'per_b', name: '', date: '2026-11-13' },
    ];
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Router initialEntries={['/today']}>
          <Routes>
            <Route path="/today" element={<Today />} />
          </Routes>
        </Router>
      </QueryClientProvider>,
    );
    const card = (await screen.findByRole('heading', { name: 'Birthdays' })).closest('section') as HTMLElement;
    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(card.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(rows[0]).toHaveTextContent(hostile);
    expect(within(rows[0]!).getByRole('link')).toHaveAttribute('href', expect.stringMatching(/^\/relationships\?tab=people&person=per_a/));
    expect(within(card).getByText('2')).toBeInTheDocument(); // the muted header count equals the row count
  });
  it('KILLS: an unparsable stored value is echoed as text, never throws', () => {
    expect(formatBirthday('2026-13-45')).toBe('2026-13-45');
  });
});

describe('format helpers', () => {
  it('KILLS: Feb 29 proximity follows the server rule (Feb 28 in a non leap year)', () => {
    const feb25 = new Date(2027, 1, 25, 12).getTime();
    expect(birthdayProximity('02-29', feb25)).toBe('in 3 days');
    expect(birthdayProximity('2000-02-29', new Date(2027, 1, 28, 12).getTime())).toBe('today');
    expect(birthdayProximity('02-29', new Date(2028, 1, 25, 12).getTime())).toBe('in 4 days');
  });
  it('KILLS: the proximity window is today..7 and wraps the year end', () => {
    const dec28 = new Date(2026, 11, 28, 12).getTime();
    expect(birthdayProximity('01-04', dec28)).toBe('in 7 days');
    expect(birthdayProximity('01-05', dec28)).toBeNull();
    expect(birthdayProximity('12-27', dec28)).toBeNull();
    expect(birthdayProximity('12-28', dec28)).toBe('today');
  });
  it('KILLS: DST spring forward and fall back keep whole day counts', () => {
    expect(birthdayProximity('03-14', new Date(2026, 2, 8, 12).getTime())).toBe('in 6 days');
    expect(birthdayProximity('11-08', new Date(2026, 10, 1, 12).getTime())).toBe('in 7 days');
  });
});
