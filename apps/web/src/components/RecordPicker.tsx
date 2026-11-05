import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSearch } from '../api/hooks';
import { errorMessage } from './common';
import { Icon } from './Icons';
import { personName } from '../lib/format';
import { useDebouncedValue } from '../lib/useDebouncedValue';

export type PickerKind = 'person' | 'organization';

// What the picker hands back. A person also carries its organization so a form can prefill from it.
export interface PickedRecord {
  id: string;
  name: string;
  detail?: string;
  organizationId?: string | null;
  organizationName?: string | null;
}

const MAX_MATCHES = 8;

// A single line search input over the search endpoint. It picks existing records only and never creates one.
export function RecordPicker({
  kind,
  label,
  value,
  onChange,
  autoFocus,
}: {
  kind: PickerKind;
  label: string;
  value: PickedRecord | null;
  onChange: (record: PickedRecord | null) => void;
  autoFocus?: boolean;
}) {
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const labelId = `${baseId}-label`;
  const inputRef = useRef<HTMLInputElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  // Which control gets focus once the picker swaps between the input and the chosen name.
  const focusNext = useRef<'input' | 'clear' | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const debounced = useDebouncedValue(query.trim(), 180);
  const search = useSearch(debounced);

  const matches = useMemo<PickedRecord[]>(() => {
    if (!debounced) return [];
    if (kind === 'person') {
      return (search.data?.people ?? []).slice(0, MAX_MATCHES).map((person) => ({
        id: person.id,
        name: personName(person),
        detail: person.organizationName || person.title || undefined,
        organizationId: person.organizationId ?? null,
        organizationName: person.organizationName ?? null,
      }));
    }
    return (search.data?.organizations ?? []).slice(0, MAX_MATCHES).map((organization) => ({
      id: organization.id,
      name: organization.name,
      detail: organization.domain || undefined,
    }));
  }, [debounced, kind, search.data]);

  useEffect(() => {
    setActiveIndex(0);
  }, [debounced, matches.length]);

  useEffect(() => {
    if (focusNext.current === 'input') inputRef.current?.focus();
    else if (focusNext.current === 'clear') clearRef.current?.focus();
    focusNext.current = null;
  }, [value]);

  const noun = kind === 'person' ? 'people' : 'organizations';
  // The list reflects the typed text only once the debounce has caught up with the input.
  const listCurrent = debounced === query.trim();
  const settled = debounced.length > 0 && listCurrent && !search.isFetching;
  const showPopover = open && query.trim().length > 0;

  const choose = (record: PickedRecord) => {
    focusNext.current = 'clear';
    setQuery('');
    setOpen(false);
    onChange(record);
  };

  const clear = () => {
    focusNext.current = 'input';
    onChange(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!showPopover) setOpen(query.trim().length > 0);
      else if (listCurrent && matches.length) setActiveIndex((index) => (index + 1) % matches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (showPopover && listCurrent && matches.length) setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
    } else if (event.key === 'Enter') {
      // Enter only ever chooses here, so it never submits the form behind the picker. A choice applies only once
      // the list reflects the typed text, so a stale match from the previous query is never taken.
      event.preventDefault();
      if (showPopover && listCurrent) {
        const record = matches[activeIndex];
        if (record) choose(record);
      }
    } else if (event.key === 'Escape') {
      // Closing the list is enough; the sheet stays open until the next Escape.
      if (showPopover) {
        event.preventDefault();
        setOpen(false);
      }
    }
  };

  if (value) {
    return (
      <div className="picker">
        <span className="field-label" id={labelId}>
          {label}
        </span>
        <div className="picker__chosen" role="group" aria-labelledby={labelId}>
          <span className="picker__name">{value.name}</span>
          <button
            ref={clearRef}
            type="button"
            className="icon-btn icon-btn--small"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={clear}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="picker">
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        className="input"
        type="text"
        role="combobox"
        aria-expanded={showPopover}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showPopover && matches[activeIndex] ? `${baseId}-option-${activeIndex}` : undefined}
        placeholder={kind === 'person' ? 'Search people' : 'Search organizations'}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showPopover ? (
        <div className="picker__popover">
          <div className="picker__list" id={listId} role="listbox" aria-label={`Matching ${noun}`}>
            {matches.map((record, index) => (
              <div
                key={record.id}
                id={`${baseId}-option-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={`picker__option${index === activeIndex ? ' is-active' : ''}`}
                // Keep focus in the input so blur does not close the list before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => choose(record)}
              >
                <span className="picker__option-name">{record.name}</span>
                {record.detail ? <span className="picker__option-detail">{record.detail}</span> : null}
              </div>
            ))}
          </div>
          {search.isError ? (
            <p className="picker__note" role="alert">
              Search failed. {errorMessage(search.error)}
            </p>
          ) : null}
          {!search.isError && matches.length === 0 ? (
            <p className="picker__note" role="status">
              {settled ? `No ${noun} match this search.` : 'Searching...'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
