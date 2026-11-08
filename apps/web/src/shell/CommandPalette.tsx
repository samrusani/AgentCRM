import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSearch, useStartRun } from '../api/hooks';
import { errorMessage } from '../components/common';
import { Icon, type IconName } from '../components/Icons';
import { formatAmount, formatDate, personName } from '../lib/format';
import { useUI } from '../lib/ui';

interface PaletteItem {
  id: string;
  group: 'People' | 'Organizations' | 'Opportunities' | 'Meetings' | 'Tasks' | 'Notes' | 'Actions';
  label: string;
  detail?: string;
  icon: IconName;
  run: () => void;
}

const GROUP_ORDER: PaletteItem['group'][] = ['People', 'Organizations', 'Opportunities', 'Meetings', 'Tasks', 'Notes', 'Actions'];

// The sheet of a parent record, the same destinations the People, Organizations, and Opportunities rows use.
function recordPath(entityType: 'person' | 'organization' | 'opportunity', entityId: string): string {
  if (entityType === 'person') return `/relationships?tab=people&person=${entityId}`;
  if (entityType === 'organization') return `/relationships?tab=organizations&org=${entityId}`;
  return `/pipeline?opportunity=${entityId}`;
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function CommandPalette() {
  const { paletteOpen } = useUI();
  return paletteOpen ? <PaletteDialog /> : null;
}

function PaletteDialog() {
  const { setPaletteOpen, toggleAppearance, pushToast } = useUI();
  const navigate = useNavigate();
  const startRun = useStartRun();
  // A ref, because the item list is memoized and would otherwise hold a stale pending flag.
  const startingRef = useRef(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounced = useDebounced(query.trim(), 150);
  const search = useSearch(debounced);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  const close = () => setPaletteOpen(false);

  const items = useMemo<PaletteItem[]>(() => {
    const go = (path: string) => () => {
      close();
      navigate(path);
    };
    const result: PaletteItem[] = [];
    const data = debounced ? search.data : undefined;
    for (const person of data?.people ?? []) {
      result.push({
        id: `person:${person.id}`,
        group: 'People',
        label: personName(person),
        detail: [person.title, person.organizationName].filter(Boolean).join(' at '),
        icon: 'people',
        run: go(`/relationships?tab=people&person=${person.id}`),
      });
    }
    for (const organization of data?.organizations ?? []) {
      result.push({
        id: `organization:${organization.id}`,
        group: 'Organizations',
        label: organization.name,
        detail: [organization.kind, organization.domain].filter(Boolean).join(', '),
        icon: 'building',
        run: go(`/relationships?tab=organizations&org=${organization.id}`),
      });
    }
    for (const opportunity of data?.opportunities ?? []) {
      result.push({
        id: `opportunity:${opportunity.id}`,
        group: 'Opportunities',
        label: opportunity.name,
        detail: [opportunity.organizationName, formatAmount(opportunity.amountTarget, opportunity.currency)]
          .filter(Boolean)
          .join(', '),
        icon: 'deal',
        run: go(`/pipeline?opportunity=${opportunity.id}`),
      });
    }
    for (const meeting of data?.meetings ?? []) {
      result.push({
        id: `meeting:${meeting.id}`,
        group: 'Meetings',
        label: meeting.title,
        detail: formatDate(meeting.startsAt),
        icon: 'meeting',
        // The same destination the Today screen links to: the Meetings screen with this meeting's sheet open.
        run: go(`/meetings?meeting=${encodeURIComponent(meeting.id)}`),
      });
    }
    for (const task of data?.tasks ?? []) {
      result.push({
        id: `task:${task.id}`,
        group: 'Tasks',
        label: task.title,
        detail: task.entityName ?? '',
        icon: 'today',
        // Tasks have no sheet of their own. A linked task opens its record's sheet; a task with no linked record opens
        // /today, the screen that lists open tasks.
        run: go(task.entityType && task.entityId ? recordPath(task.entityType, task.entityId) : '/today'),
      });
    }
    for (const note of data?.notes ?? []) {
      result.push({
        id: `note:${note.id}`,
        group: 'Notes',
        label: note.snippet,
        detail: note.entityName,
        icon: 'pencil',
        run: go(recordPath(note.entityType, note.entityId)),
      });
    }
    const actions: PaletteItem[] = [
      {
        id: 'action:demo',
        group: 'Actions',
        label: 'Start demo research',
        detail: 'Simulated run, no model connected',
        icon: 'research',
        run: () => {
          if (startingRef.current) return;
          startingRef.current = true;
          startRun.mutate(undefined, {
            onSuccess: (run) => {
              startingRef.current = false;
              close();
              navigate(`/research?run=${run.id}`);
            },
            onError: (error) => {
              startingRef.current = false;
              close();
              pushToast(`Could not start the run. ${errorMessage(error)}`, 'error');
            },
          });
        },
      },
      {
        id: 'action:appearance',
        group: 'Actions',
        label: 'Toggle appearance',
        detail: 'Switch between light and dark',
        icon: 'sun',
        run: () => {
          toggleAppearance();
          close();
        },
      },
    ];
    const needle = query.trim().toLowerCase();
    for (const action of actions) {
      if (!needle || action.label.toLowerCase().includes(needle)) result.push(action);
    }
    return GROUP_ORDER.flatMap((group) => result.filter((item) => item.group === group));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, query, search.data]);

  useEffect(() => {
    setActiveIndex(0);
  }, [items.length, debounced]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-palette-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (items.length) setActiveIndex((index) => (index + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length) setActiveIndex((index) => (index - 1 + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      items[activeIndex]?.run();
    } else if (event.key === 'Tab') {
      event.preventDefault();
    }
  };

  const searching = debounced.length > 0 && (search.isFetching || debounced !== query.trim());
  const hasSearchResults = items.some((item) => item.group !== 'Actions');
  let flatIndex = -1;

  return (
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette__field">
          <Icon name="search" />
          <input
            ref={inputRef}
            className="palette__input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[activeIndex] ? `palette-option-${activeIndex}` : undefined}
            aria-label="Search people, organizations, deals, meetings, tasks, and notes"
            placeholder="Search or run an action"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="palette__list" id="palette-list" role="listbox" ref={listRef}>
          {GROUP_ORDER.map((group) => {
            const groupItems = items.filter((item) => item.group === group);
            if (groupItems.length === 0) return null;
            return (
              <div key={group} role="group" aria-label={group}>
                <div className="palette__group">{group}</div>
                {groupItems.map((item) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  return (
                    <div
                      key={item.id}
                      id={`palette-option-${index}`}
                      data-palette-index={index}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={`palette__item${index === activeIndex ? ' is-active' : ''}`}
                      onMouseMove={() => setActiveIndex(index)}
                      onClick={() => item.run()}
                    >
                      <Icon name={item.icon} />
                      <span className="palette__label">{item.label}</span>
                      {item.detail ? <span className="palette__detail">{item.detail}</span> : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {debounced && search.isError ? (
            <p className="palette__note" role="alert">
              Search failed. {errorMessage(search.error)}
            </p>
          ) : null}
          {debounced && !searching && !search.isError && !hasSearchResults ? (
            <p className="palette__note">No people, organizations, deals, meetings, tasks, or notes match this search.</p>
          ) : null}
          {!debounced ? (
            <p className="palette__note">Search people, organizations, deals, meetings, tasks, and notes.</p>
          ) : null}
        </div>
        <div className="palette__footer" aria-hidden="true">
          <span>Up and down to move</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
