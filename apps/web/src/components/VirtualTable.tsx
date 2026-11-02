import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface Column<T> {
  key: string;
  header: string;
  width: string;
  numeric?: boolean;
  // Replaces the plain header text, for example with a sort control.
  headerContent?: ReactNode;
  ariaSort?: 'ascending' | 'descending' | 'none';
  render: (row: T) => ReactNode;
}

const ROW_HEIGHT = 36;

export function VirtualTable<T>({
  label,
  columns,
  rows,
  getKey,
  selectedKey,
  onOpen,
  onNearEnd,
}: {
  label: string;
  columns: Column<T>[];
  rows: T[];
  getKey: (row: T) => string;
  selectedKey?: string | null;
  onOpen: (row: T) => void;
  onNearEnd?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const focusAfterRender = useRef(false);
  const template = columns.map((column) => column.width).join(' ');

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length > 0 ? items[items.length - 1].index : -1;

  useEffect(() => {
    if (onNearEnd && rows.length > 0 && lastIndex >= rows.length - 15) onNearEnd();
  }, [lastIndex, rows.length, onNearEnd]);

  useEffect(() => {
    if (activeIndex >= rows.length && rows.length > 0) setActiveIndex(rows.length - 1);
  }, [rows.length, activeIndex]);

  useEffect(() => {
    if (!focusAfterRender.current) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (element) {
      element.focus();
      focusAfterRender.current = false;
    }
  }, [activeIndex, items]);

  const moveTo = (index: number) => {
    const next = Math.min(rows.length - 1, Math.max(0, index));
    focusAfterRender.current = true;
    setActiveIndex(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number, row: T) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveTo(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(index - 1);
        break;
      case 'PageDown':
        event.preventDefault();
        moveTo(index + 10);
        break;
      case 'PageUp':
        event.preventDefault();
        moveTo(index - 10);
        break;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        break;
      case 'End':
        event.preventDefault();
        moveTo(rows.length - 1);
        break;
      case 'Enter':
      case ' ':
        if (event.target === event.currentTarget) {
          event.preventDefault();
          onOpen(row);
        }
        break;
      default:
        break;
    }
  };

  return (
    <div className="vtable" ref={scrollRef}>
      <div className="vtable__grid" role="grid" aria-label={label} aria-rowcount={rows.length + 1}>
        <div className="vtable__header" role="row" style={{ gridTemplateColumns: template }}>
          {columns.map((column) => (
            <div
              key={column.key}
              role="columnheader"
              aria-sort={column.ariaSort}
              className={`vtable__head-cell${column.numeric ? ' is-numeric' : ''}`}
            >
              {column.headerContent ?? column.header}
            </div>
          ))}
        </div>
        <div className="vtable__body" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index];
            const key = getKey(row);
            const selected = selectedKey === key;
            return (
              <div
                key={key}
                role="row"
                data-index={item.index}
                aria-rowindex={item.index + 2}
                aria-selected={selected}
                tabIndex={item.index === activeIndex ? 0 : -1}
                className={`vtable__row${selected ? ' is-selected' : ''}`}
                style={{
                  gridTemplateColumns: template,
                  height: ROW_HEIGHT,
                  transform: `translateY(${item.start}px)`,
                }}
                onClick={() => {
                  setActiveIndex(item.index);
                  onOpen(row);
                }}
                onFocus={() => setActiveIndex(item.index)}
                onKeyDown={(event) => onRowKeyDown(event, item.index, row)}
              >
                {columns.map((column) => (
                  <div
                    key={column.key}
                    role="gridcell"
                    className={`vtable__cell${column.numeric ? ' is-numeric' : ''}`}
                  >
                    {column.render(row)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
