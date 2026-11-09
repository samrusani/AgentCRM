// Adversarial review probes for the six-line timeline clamp (docs/design.md, Record detail, "Long timeline bodies
// collapse"). Names start with KILLS (real defect, written as it.fails), CONFIRMS (suspected defect that does not
// exist), or ACCEPTED (odd but contract-consistent). Nothing here changes application code.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Timeline } from '../src/components/record';
import { Sheet } from '../src/components/common';
import type { Activity } from '../src/api/types';

vi.mock('../src/components/prepareSend', () => ({
  PrepareToSend: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

const components = readFileSync(path.join(__dirname, '../src/styles/components.css'), 'utf8');

function activity(id: string, body: string, kind: Activity['kind'] = 'note'): Activity {
  return { id, entityType: 'person', entityId: 'p1', kind, body, actor: 'You', createdAt: '2026-01-01T00:00:00.000Z' };
}

// A layout stand-in: bodies containing LONG overflow six lines while clamped and fit once the clamp class is gone,
// which is what a real browser reports (an expanded body no longer overflows its own box).
let longMeansOverflow = true;
function stubLayout() {
  const clamped = (el: HTMLElement) => el.classList.contains('timeline__body--clamped');
  const isLong = (el: HTMLElement) => longMeansOverflow && (el.textContent ?? '').includes('LONG');
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: function (this: HTMLElement) { return isLong(this) ? 300 : 80; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: function (this: HTMLElement) { return isLong(this) && clamped(this) ? 120 : isLong(this) ? 300 : 80; } });
}

beforeEach(() => {
  longMeansOverflow = true;
  stubLayout();
});
afterEach(() => {
  // @ts-expect-error remove the stubs so other tests see jsdom defaults
  delete HTMLElement.prototype.scrollHeight;
  // @ts-expect-error remove the stubs so other tests see jsdom defaults
  delete HTMLElement.prototype.clientHeight;
  vi.restoreAllMocks();
});

describe('toggle visibility', () => {
  it('CONFIRMS: an expanded entry keeps "Show less" although its box no longer overflows (amended contract)', async () => {
    const user = userEvent.setup();
    render(<Timeline activities={[activity('a', 'LONG note')]} />);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    const body = screen.getByText('LONG note');
    expect(body.scrollHeight).toBe(body.clientHeight);
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('CONFIRMS: equal heights grow no control, and one pixel of overflow does', () => {
    const { unmount } = render(<Timeline activities={[activity('a', 'short')]} />);
    expect(screen.queryByRole('button', { name: /show/i })).toBeNull();
    unmount();
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 121 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 120 });
    render(<Timeline activities={[activity('a', 'edge')]} />);
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });

  it('CONFIRMS: expansion is per entry, and a refetch that prepends a new entry keeps the expanded one expanded', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Timeline activities={[activity('a', 'LONG first'), activity('b', 'LONG second')]} />);
    await user.click(screen.getAllByRole('button', { name: 'Show more' })[1]!);
    rerender(<Timeline activities={[activity('c', 'LONG fresh'), activity('a', 'LONG first'), activity('b', 'LONG second')]} />);
    expect(screen.getByText('LONG second')).not.toHaveClass('timeline__body--clamped');
    expect(screen.getByText('LONG first')).toHaveClass('timeline__body--clamped');
    expect(screen.getByText('LONG fresh')).toHaveClass('timeline__body--clamped');
  });

  it('ACCEPTED: when the same entry id arrives with a new body (edit), the expanded state is kept, because state follows the id', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Timeline activities={[activity('a', 'LONG v1')]} />);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    rerender(<Timeline activities={[activity('a', 'LONG v2')]} />);
    expect(screen.getByText('LONG v2')).not.toHaveClass('timeline__body--clamped');
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('ACCEPTED: a collapsed entry whose body is refetched short loses its toggle, an expanded one keeps it (the amended rule)', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Timeline activities={[activity('a', 'LONG v1'), activity('b', 'LONG other')]} />);
    await user.click(screen.getAllByRole('button', { name: 'Show more' })[0]!);
    rerender(<Timeline activities={[activity('a', 'tiny'), activity('b', 'tiny too')]} />);
    expect(screen.getAllByRole('button', { name: /show/i })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('CONFIRMS: expanded state lives only while the sheet is open (unmount then remount is clamped again)', async () => {
    const user = userEvent.setup();
    const first = render(<Timeline activities={[activity('a', 'LONG note')]} />);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    first.unmount();
    render(<Timeline activities={[activity('a', 'LONG note')]} />);
    expect(screen.getByText('LONG note')).toHaveClass('timeline__body--clamped');
  });

  it('CONFIRMS: a body of many short lines is clamped by the same class (the clamp is CSS line based, not character based)', () => {
    render(<Timeline activities={[activity('a', Array.from({ length: 40 }, (_, i) => `LONG ${i}`).join('\n'))]} />);
    expect(document.querySelector('.timeline__body')).toHaveClass('timeline__body--clamped');
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });

  it('CONFIRMS: every kind is clamped, notes, drafts, received mail and agent output alike', () => {
    const kinds: Activity['kind'][] = ['note', 'email_draft', 'email_received', 'email_sent', 'stage_change'] as Activity['kind'][];
    render(<Timeline activities={kinds.map((k, i) => activity(`k${i}`, `LONG ${k}`, k))} />);
    expect(document.querySelectorAll('.timeline__body--clamped')).toHaveLength(kinds.length);
    expect(screen.getAllByRole('button', { name: 'Show more' })).toHaveLength(kinds.length);
  });
});

describe('email draft chrome', () => {
  it('CONFIRMS: a clamped draft keeps the chip, the actor line and Prepare to send visible after the body', () => {
    render(<Timeline activities={[activity('d', 'LONG draft', 'email_draft')]} prepareSend />);
    expect(screen.getByText('Draft, not sent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare to send' })).toBeInTheDocument();
    const body = screen.getByText('LONG draft');
    const prepare = screen.getByRole('button', { name: 'Prepare to send' });
    expect(body.compareDocumentPosition(prepare) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(body).toHaveClass('timeline__body--clamped');
  });

  it('CONFIRMS: the toggle sits directly under the body, before the actor line and Prepare to send', () => {
    render(<Timeline activities={[activity('d', 'LONG draft', 'email_draft')]} prepareSend />);
    const body = screen.getByText('LONG draft');
    expect(body.nextElementSibling).toBe(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show more' }).nextElementSibling).toHaveTextContent('You');
  });
});

describe('resize listener lifecycle', () => {
  function resizeCalls(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.filter((c) => c[0] === 'resize').map((c) => c[1]);
  }

  it('CONFIRMS: every resize listener added is removed on unmount (same function, nothing leaks)', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const user = userEvent.setup();
    const { unmount } = render(<Timeline activities={[activity('a', 'LONG one'), activity('b', 'LONG two'), activity('c', 'short')]} />);
    await user.click(screen.getAllByRole('button', { name: 'Show more' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Show less' }));
    unmount();
    const added = resizeCalls(add);
    const removed = resizeCalls(remove);
    expect(added.length).toBeGreaterThanOrEqual(3);
    expect(removed.length).toBe(added.length);
    for (const fn of added) expect(removed).toContain(fn);
  });

  it('CONFIRMS: after unmount a window resize touches nothing and throws nothing', () => {
    const { unmount } = render(<Timeline activities={[activity('a', 'LONG one')]} />);
    unmount();
    expect(() => act(() => void window.dispatchEvent(new Event('resize')))).not.toThrow();
  });

  it('CONFIRMS: a resize re-measures, showing the toggle when the width shrinks and removing it when it grows (collapsed entry)', () => {
    longMeansOverflow = false;
    render(<Timeline activities={[activity('a', 'LONG note')]} />);
    expect(screen.queryByRole('button', { name: /show/i })).toBeNull();
    longMeansOverflow = true;
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
    longMeansOverflow = false;
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(screen.queryByRole('button', { name: /show/i })).toBeNull();
  });

  it('ACCEPTED: one resize listener per entry, each reading layout unthrottled; bounded by the number of timeline entries on an open sheet', () => {
    const add = vi.spyOn(window, 'addEventListener');
    render(<Timeline activities={Array.from({ length: 25 }, (_, i) => activity(`n${i}`, 'LONG body'))} />);
    expect(resizeCalls(add)).toHaveLength(25);
  });
});

describe('focus and event isolation', () => {
  it('CONFIRMS: expanding keeps focus on the same toggle element, from a click or from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Timeline activities={[activity('a', 'LONG note')]} />);
    const before = screen.getByRole('button', { name: 'Show more' });
    await user.click(before);
    const after = screen.getByRole('button', { name: 'Show less' });
    expect(after).toBe(before);
    expect(after).toHaveFocus();
  });

  it('CONFIRMS: Enter on the focused toggle expands it and focus stays', async () => {
    const user = userEvent.setup();
    render(<Timeline activities={[activity('a', 'LONG note')]} />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveFocus();
  });

  it('KILLS, fixed: collapsing with "Show less" keeps focus on the toggle (overflow is not re-measured while expanded, so the button never unmounts)', async () => {
    // Contract: expansion never moves focus and the toggle is the same element across expand and collapse.
    // useClampOverflow is paused while the entry is expanded and keeps the last clamped measurement.
    const user = userEvent.setup();
    render(<Timeline activities={[activity('a', 'LONG note')]} />);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await user.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveFocus();
  });

  it('KILLS, fixed: the toggle stays the same element across a keyboard expand and collapse', async () => {
    const user = userEvent.setup();
    render(<Timeline activities={[activity('a', 'LONG note')]} />);
    await user.tab();
    const toggle = screen.getByRole('button', { name: 'Show more' });
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Show more' })).toBe(toggle);
  });

  it('CONFIRMS: the toggle does not close the sheet, does not submit an enclosing form, and carries aria-expanded', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <Sheet title="Person" onClose={onClose}>
        <form onSubmit={onSubmit}>
          <Timeline activities={[activity('a', 'LONG note')]} />
        </form>
      </Sheet>,
    );
    const toggle = screen.getByRole('button', { name: 'Show more' });
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    expect(onClose).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('css', () => {
  const block = (selector: string) => {
    const at = components.indexOf(`${selector} {`);
    return at < 0 ? '' : components.slice(components.indexOf('{', at) + 1, components.indexOf('}', at));
  };

  it('CONFIRMS: the clamp is six lines with the standard and the webkit properties, and the base keeps pre-wrap so newlines count as lines', () => {
    const clamped = block('.timeline__body--clamped');
    expect(clamped).toContain('-webkit-line-clamp: 6');
    expect(clamped).toContain('line-clamp: 6');
    expect(clamped).toContain('display: -webkit-box');
    expect(clamped).toContain('-webkit-box-orient: vertical');
    expect(block('.timeline__body')).toContain('white-space: pre-wrap');
    expect(clamped).not.toMatch(/max-height|height:|white-space/);
  });

  it('KILLS, fixed: an unbroken run such as a pasted URL wraps (overflow-wrap on the body), so the clamp can only shorten text downward, never clip it sideways', () => {
    // Without a wrap property an unbroken run wider than the 480px sheet would be cut by the clamped rule's
    // overflow: hidden, with no toggle because the height check sees no overflow.
    const wraps = /overflow-wrap:\s*(anywhere|break-word)|word-break:\s*(break-all|break-word)/;
    const chain = [block('.timeline__body'), block('.timeline__body--clamped'), block('.timeline__item'), block('.timeline'), block('.sheet__body')].join('\n');
    expect(chain).toMatch(wraps);
  });
});
