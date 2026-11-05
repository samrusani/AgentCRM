import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../api/client';
import { runStatusLabel } from '../lib/format';
import { Icon } from './Icons';

export type ChipTone = 'neutral' | 'accent' | 'warn' | 'danger';

export function Chip({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip chip--${tone}`} title={title}>
      {children}
    </span>
  );
}

export function ChipButton({
  tone = 'neutral',
  pressed,
  children,
  ...rest
}: { tone?: ChipTone; pressed?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`chip chip--${tone} chip--button`} aria-pressed={pressed} {...rest}>
      {children}
    </button>
  );
}

export function SimulatedChip() {
  return (
    <Chip tone="neutral" title="No model is connected. This run is scripted and produces synthetic data.">
      Simulated
    </Chip>
  );
}

export function RunStatusChip({ status }: { status: string }) {
  const tone: ChipTone = status === 'waiting_approval' ? 'warn' : status === 'failed' ? 'danger' : 'neutral';
  return <Chip tone={tone}>{runStatusLabel(status)}</Chip>;
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading__label">Loading {what}</span>
      <span className="loading__rule" />
      <span className="loading__rule loading__rule--short" />
      <span className="loading__rule" />
    </div>
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something unexpected happened. Retry, and check the server log if it continues.';
}

export function ErrorState({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">Could not load {what}</p>
      <p className="state__body">{errorMessage(error)}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  message,
  actionLabel,
  onAction,
  busy,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="state">
      <p className="state__body">{message}</p>
      {actionLabel && onAction ? (
        <button type="button" className="btn" onClick={onAction} disabled={busy}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      {description ? (
        <div className="page-header__text">
          <h1 className="page-title">{title}</h1>
          <p className="page-header__description muted">{description}</p>
        </div>
      ) : (
        <h1 className="page-title">{title}</h1>
      )}
      {children ? <div className="page-header__actions">{children}</div> : null}
    </div>
  );
}

export function Sheet({
  title,
  subtitle,
  onClose,
  wide,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <aside className={`sheet${wide ? ' sheet--wide' : ''}`} role="dialog" aria-label={title}>
      <header className="sheet__header">
        <div className="sheet__heading">
          <h2 className="sheet__title" tabIndex={-1} ref={headingRef}>
            {title}
          </h2>
          {subtitle ? <p className="sheet__subtitle">{subtitle}</p> : null}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details">
          <Icon name="close" />
        </button>
      </header>
      <div className="sheet__body">{children}</div>
    </aside>
  );
}

export interface MenuItem {
  key: string;
  label: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function ActionMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const width = 208;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
    const estimatedHeight = items.length * 30 + 12;
    const top =
      rect.bottom + estimatedHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - estimatedHeight - 4)
        : rect.bottom + 4;
    setPosition({ top, left });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const first = listRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!listRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    };
    const onViewportChange = () => close(false);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onViewportChange);
    // Capture phase, so scrolling any ancestor container closes the menu too.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && listRef.current?.contains(event.target)) return;
      close(false);
    };
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, position, close]);

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The menu renders in a portal but React events still bubble to the row or card that owns it.
    event.stopPropagation();
    const nodes = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      nodes[(index + 1) % nodes.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      nodes[(index - 1 + nodes.length) % nodes.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      nodes[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      nodes[nodes.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="more" />
      </button>
      {open
        ? createPortal(
            <div
              ref={listRef}
              className="menu"
              role="menu"
              aria-label={label}
              style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}
              onKeyDown={onListKeyDown}
              onClick={(event) => event.stopPropagation()}
            >
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  className="menu__item"
                  disabled={item.disabled}
                  onClick={() => {
                    close(true);
                    item.onSelect();
                  }}
                >
                  <span className="menu__check">{item.checked ? <Icon name="check" /> : null}</span>
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
