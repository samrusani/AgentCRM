import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Timeline } from '../../src/components/record';
import type { Activity } from '../../src/api/types';

function activity(id: string, body: string, kind: Activity['kind'] = 'note'): Activity {
  return { id, entityType: 'person', entityId: 'p1', kind, body, actor: 'You', createdAt: '2026-01-01T00:00:00.000Z' };
}

// jsdom reports 0 for both heights, so tests stub them on the prototype.
function stubHeights(scrollHeight: number, clientHeight: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => clientHeight });
}

afterEach(() => {
  // @ts-expect-error remove the stubs so other tests see jsdom defaults
  delete HTMLElement.prototype.scrollHeight;
  // @ts-expect-error remove the stubs so other tests see jsdom defaults
  delete HTMLElement.prototype.clientHeight;
});

describe('timeline body clamp', () => {
  it('clamps by default and shows no toggle when the body fits', () => {
    stubHeights(80, 80);
    render(<Timeline activities={[activity('a', 'Short note')]} />);
    expect(screen.getByText('Short note')).toHaveClass('timeline__body--clamped');
    expect(screen.queryByRole('button', { name: /show (more|less)/i })).not.toBeInTheDocument();
  });

  it('shows Show more when the body overflows, expands, and collapses again', async () => {
    stubHeights(300, 120);
    const user = userEvent.setup();
    render(<Timeline activities={[activity('a', 'A very long note')]} />);
    const body = screen.getByText('A very long note');
    expect(body).toHaveClass('timeline__body--clamped');
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(body).not.toHaveClass('timeline__body--clamped');
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show less' }));
    expect(body).toHaveClass('timeline__body--clamped');
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });

  it('keeps the expanded state per entry', async () => {
    stubHeights(300, 120);
    const user = userEvent.setup();
    render(<Timeline activities={[activity('a', 'First long'), activity('b', 'Second long')]} />);
    await user.click(screen.getAllByRole('button', { name: 'Show more' })[0]!);
    expect(screen.getByText('First long')).not.toHaveClass('timeline__body--clamped');
    expect(screen.getByText('Second long')).toHaveClass('timeline__body--clamped');
    expect(screen.getAllByRole('button', { name: 'Show more' })).toHaveLength(1);
  });

  it('keeps the draft chip and actor line below a clamped email draft', () => {
    stubHeights(300, 120);
    render(<Timeline activities={[activity('d', 'Hello there, long draft', 'email_draft')]} />);
    expect(screen.getByText('Draft, not sent')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });
});
