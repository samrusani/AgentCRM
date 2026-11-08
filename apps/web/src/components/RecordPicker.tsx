import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSearch } from '../api/hooks';
import { ApiError } from '../api/client';
import { errorMessage } from './common';
import { Icon } from './Icons';
import { personName } from '../lib/format';
import { stripInvisible } from '../lib/leads';
import { useDebouncedValue } from '../lib/useDebouncedValue';

export type PickerKind = 'person' | 'organization' | 'opportunity';

// What the picker hands back. A person also carries its organization so a form can prefill from it.
export interface PickedRecord {
  id: string;
  name: string;
  detail?: string;
  organizationId?: string | null;
  organizationName?: string | null;
}

const MAX_MATCHES = 8;

// The create failure note is always a full sentence and ends with the next step: fix the name when the server refused
// it as invalid, try again for anything else (an unreachable server, a 5xx).
function createFailure(error: unknown): string {
  const message = errorMessage(error).trim();
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  const next = error instanceof ApiError && error.status === 400 ? 'Fix the name and try again.' : 'Try again.';
  return `${sentence} ${next}`;
}

// A single line search input over the search endpoint. It picks existing records and never creates one, unless the call
// site passes onCreate for organizations. Then one last option adds the typed text as a new organization and picks it.
export function RecordPicker({
  kind,
  label,
  value,
  onChange,
  autoFocus,
  onCreate,
  hideLabel,
}: {
  kind: PickerKind;
  label: string;
  value: PickedRecord | null;
  onChange: (record: PickedRecord | null) => void;
  autoFocus?: boolean;
  // Turns on the create option. It is honored for organizations only and resolves to the record it made.
  onCreate?: (name: string) => Promise<PickedRecord>;
  // Hides the visible label when the surrounding row already names the field. The input keeps it as its accessible name.
  hideLabel?: boolean;
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
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Set when a create fails, so focus returns to the input once it is enabled again.
  const refocusInput = useRef(false);
  // State alone cannot stop two key events handled before the next render, so a ref guards the create too.
  const createRunning = useRef(false);
  // The typed text without invisible format characters and edge whitespace. Search, the create option, and the
  // name sent to onCreate all use it, and text that leaves nothing here counts as empty.
  const typed = stripInvisible(query).trim();
  const debounced = useDebouncedValue(typed, 180);
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
    if (kind === 'opportunity') {
      return (search.data?.opportunities ?? []).slice(0, MAX_MATCHES).map((opportunity) => ({
        id: opportunity.id,
        name: opportunity.name,
        detail: opportunity.organizationName || undefined,
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

  const noun = kind === 'person' ? 'people' : kind === 'opportunity' ? 'deals' : 'organizations';
  // The list reflects the typed text only once the debounce has caught up with the input.
  const listCurrent = debounced === typed;
  const settled = debounced.length > 0 && listCurrent && !search.isFetching;
  const showPopover = open && typed.length > 0;
  // The create option waits for the search to settle, so it never appears beside a list that is about to change.
  const showCreate = Boolean(onCreate) && kind === 'organization' && settled && !search.isError;
  const optionCount = matches.length + (showCreate ? 1 : 0);
  const active = optionCount > 0 ? Math.min(activeIndex, optionCount - 1) : 0;

  useEffect(() => {
    if (!creating && refocusInput.current) {
      refocusInput.current = false;
      inputRef.current?.focus();
    }
  }, [creating]);

  const choose = (record: PickedRecord) => {
    focusNext.current = 'clear';
    setQuery('');
    setOpen(false);
    onChange(record);
  };

  // The typed text stays in place while the create runs and after it fails, so the user can retry or fix the name.
  const create = async () => {
    if (!onCreate || createRunning.current) return;
    createRunning.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const record = await onCreate(typed);
      createRunning.current = false;
      setCreating(false);
      choose(record);
    } catch (error) {
      createRunning.current = false;
      refocusInput.current = true;
      setCreating(false);
      setCreateError(createFailure(error));
    }
  };

  const clear = () => {
    focusNext.current = 'input';
    onChange(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!showPopover) setOpen(typed.length > 0);
      else if (settled && optionCount) setActiveIndex((index) => (Math.min(index, optionCount - 1) + 1) % optionCount);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (showPopover && settled && optionCount) {
        setActiveIndex((index) => (Math.min(index, optionCount - 1) - 1 + optionCount) % optionCount);
      }
    } else if (event.key === 'Enter') {
      // Enter only ever chooses here, so it never submits the form behind the picker. A choice applies only once
      // the list reflects the typed text and no search is in flight, so a stale match is never taken.
      event.preventDefault();
      if (showPopover && settled && !creating) {
        const record = matches[active];
        if (record) choose(record);
        else if (showCreate && active === matches.length) void create();
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
        {hideLabel ? null : (
          <span className="field-label" id={labelId}>
            {label}
          </span>
        )}
        <div
          className="picker__chosen"
          role="group"
          aria-labelledby={hideLabel ? undefined : labelId}
          aria-label={hideLabel ? label : undefined}
        >
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
      {hideLabel ? null : (
        <label className="field-label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <input
        ref={inputRef}
        id={inputId}
        className="input"
        type="text"
        role="combobox"
        aria-expanded={showPopover}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={hideLabel ? label : undefined}
        aria-busy={creating || undefined}
        aria-activedescendant={showPopover && optionCount > 0 ? `${baseId}-option-${active}` : undefined}
        placeholder={kind === 'person' ? 'Search people' : kind === 'opportunity' ? 'Search deals' : 'Search organizations'}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={creating}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setCreateError(null);
          setOpen(true);
        }}
        // Disabling the input during a create can blur it. The popover stays open so the note and options stay in view.
        onBlur={() => {
          if (!creating) setOpen(false);
        }}
        onKeyDown={onKeyDown}
      />
      {showPopover ? (
        <div className="picker__popover">
          <div className="picker__list" id={listId} role="listbox" aria-label={`Matching ${noun}`} aria-busy={creating || undefined}>
            {matches.map((record, index) => (
              <div
                key={record.id}
                id={`${baseId}-option-${index}`}
                role="option"
                aria-selected={index === active}
                aria-disabled={creating || undefined}
                className={`picker__option${index === active ? ' is-active' : ''}`}
                // Keep focus in the input so blur does not close the list before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (!creating) setActiveIndex(index);
                }}
                onClick={() => {
                  if (!creating) choose(record);
                }}
              >
                <span className="picker__option-name">{record.name}</span>
                {record.detail ? <span className="picker__option-detail">{record.detail}</span> : null}
              </div>
            ))}
            {showCreate ? (
              <div
                id={`${baseId}-option-${matches.length}`}
                role="option"
                aria-selected={active === matches.length}
                aria-disabled={creating || undefined}
                className={`picker__option picker__option--create${active === matches.length ? ' is-active' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (!creating) setActiveIndex(matches.length);
                }}
                onClick={() => void create()}
              >
                <span className="picker__option-name">{`Add "${typed}" as a new organization`}</span>
              </div>
            ) : null}
          </div>
          {creating ? (
            <p className="picker__note" role="status">
              Adding organization...
            </p>
          ) : null}
          {createError && !creating ? (
            <p className="picker__note" role="alert">
              {createError}
            </p>
          ) : null}
          {search.isError ? (
            <p className="picker__note" role="alert">
              Search failed. {errorMessage(search.error)}
            </p>
          ) : null}
          {!search.isError && !creating && !createError && matches.length === 0 ? (
            <p className="picker__note" role="status">
              {settled ? `No ${noun} match this search.` : 'Searching...'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
