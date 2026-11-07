import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useAddListMembers, useCreateList, useLists, useRemoveListMember } from '../api/hooks';
import type { PersonList } from '../api/types';
import { addedBeforeFailure, withNextStep } from '../lib/lists';
import { errorMessage } from './common';
import { Icon } from './Icons';

const MAX_NAME = 200;

// New list is create then add. When the add fails the list already exists, so the retry (same typed name) reuses it and
// never POSTs /lists a second time. `forget` runs once the add succeeded.
export function useCreateOnce(createList: { mutateAsync: (name: string) => Promise<PersonList> }) {
  const created = useRef<{ name: string; list: PersonList } | null>(null);
  const ensure = async (name: string): Promise<PersonList> => {
    if (created.current && created.current.name === name) return created.current.list;
    const list = await createList.mutateAsync(name);
    created.current = { name, list };
    return list;
  };
  const forget = () => {
    created.current = null;
  };
  return { ensure, forget };
}

// The failure after the list exists but the add did not finish. Says the list was created and that Create again reuses it.
export function createdButNotAdded(error: unknown, listName: string, who: string): string {
  const partial = addedBeforeFailure(error);
  const lead = partial ? `The list ${listName} was created, but the add did not finish.` : `The list ${listName} was created, but ${who} was added.`;
  return withNextStep(error, `${lead}${partial ? ` ${partial}` : ''} Press Create again to retry, which reuses ${listName}.`);
}

// A button that opens a small menu of every list plus a "New list" entry that asks for a name inline. Choosing a list
// or creating one runs the caller's work; the menu stays open and disabled while it runs, shows a failure inline (the
// caller's message already says what to do next), and closes once the work succeeds. Used by the people table header and the person sheet.
export function ListMenu({
  label,
  buttonClassName = 'btn',
  lists,
  checkedIds,
  disabled,
  onPick,
  onCreate,
}: {
  label: string;
  buttonClassName?: string;
  lists: PersonList[];
  // Lists to mark with a check, for example the lists a person is already on. Choosing one is still allowed.
  checkedIds?: string[];
  disabled?: boolean;
  onPick: (list: PersonList) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const newItemRef = useRef<HTMLButtonElement>(null);
  const refocusNewItem = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setCreating(false);
    setName('');
    setProblem(null);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const width = 240;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
    const estimatedHeight = Math.min(lists.length, 9) * 28 + 80;
    const top =
      rect.bottom + estimatedHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - estimatedHeight - 4)
        : rect.bottom + 4;
    setPosition({ top, left });
  }, [open, lists.length]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (busyRef.current) return;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  // Leaving the New list form with Escape puts focus back on the New list item, so a second Escape closes the menu.
  useEffect(() => {
    if (!creating && refocusNewItem.current) {
      refocusNewItem.current = false;
      newItemRef.current?.focus();
    }
  }, [creating]);

  // The menu is anchored to the trigger, so it goes when the trigger goes away (the selection was cleared).
  useEffect(() => {
    if (disabled && open && !busyRef.current) close(false);
  }, [disabled, open, close]);

  // Callers throw errors whose message is already a full sentence ending with what to do next.
  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    setBusy(true);
    setProblem(null);
    try {
      await work();
      close(true);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(() => onCreate(trimmed));
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (busyRef.current) return;
      if (creating) {
        refocusNewItem.current = true;
        setCreating(false);
        setName('');
        setProblem(null);
      } else {
        close(true);
      }
      return;
    }
    if (event.target instanceof HTMLInputElement) return;
    const nodes = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
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
    } else if (event.key === 'Tab' && !busyRef.current) {
      close(false);
    }
  };

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {label}
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="menu menu--lists"
              role="menu"
              aria-label={label}
              aria-busy={busy}
              style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}
              onKeyDown={onMenuKeyDown}
            >
              {lists.map((list) => (
                <button
                  key={list.id}
                  type="button"
                  role="menuitem"
                  className="menu__item"
                  disabled={busy}
                  onClick={() => void run(() => onPick(list))}
                >
                  <span className="menu__check">{checkedIds?.includes(list.id) ? <Icon name="check" /> : null}</span>
                  <span className="menu__label">{list.name}</span>
                </button>
              ))}
              {lists.length > 0 ? <div className="menu__sep" role="separator" /> : null}
              {creating ? (
                <form className="menu__form" onSubmit={submitNew} noValidate>
                  <label className="sr-only" htmlFor="new-list-name">
                    New list name
                  </label>
                  <input
                    id="new-list-name"
                    className="input"
                    value={name}
                    autoFocus
                    maxLength={MAX_NAME}
                    placeholder="List name"
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
                    {busy ? 'Creating...' : 'Create'}
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  ref={newItemRef}
                  role="menuitem"
                  className="menu__item"
                  disabled={busy}
                  onClick={() => {
                    setProblem(null);
                    setCreating(true);
                  }}
                >
                  <span className="menu__check" />
                  <span className="menu__label">New list</span>
                </button>
              )}
              {problem ? (
                <p className="inline-error menu__problem" role="alert">
                  {problem}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// The person sheet's Lists row: the person's lists as chips with a quiet remove, an Add to list menu, and the muted word
// None when there are no lists. Membership edits need no version and conflict with nothing; a failure shows inline and
// ends with what to do next.
export function PersonLists({ personId, lists }: { personId: string; lists: Array<{ id: string; name: string }> }) {
  const all = useLists();
  const addMembers = useAddListMembers();
  const createList = useCreateList();
  const removeMember = useRemoveListMember();
  const createOnce = useCreateOnce(createList);
  const [problem, setProblem] = useState<string | null>(null);

  const addTo = async (list: PersonList) => {
    setProblem(null);
    try {
      await addMembers.mutateAsync({ listId: list.id, personIds: [personId] });
    } catch (error) {
      throw new Error(withNextStep(error, `This person was not added to ${list.name}. Try again.`));
    }
  };

  const addToNew = async (name: string) => {
    setProblem(null);
    let created: PersonList;
    try {
      created = await createOnce.ensure(name);
    } catch (error) {
      throw new Error(withNextStep(error, 'The list was not created. Fix the name and try again.'));
    }
    try {
      await addMembers.mutateAsync({ listId: created.id, personIds: [personId] });
      createOnce.forget();
    } catch (error) {
      throw new Error(createdButNotAdded(error, created.name, 'this person'));
    }
  };

  const remove = (list: { id: string; name: string }) => {
    setProblem(null);
    removeMember.mutate(
      { listId: list.id, personId },
      { onError: (error) => setProblem(withNextStep(error, `This person is still on ${list.name}. Try again.`)) },
    );
  };

  return (
    <div className="person-lists">
      {lists.length > 0 ? (
        <ul className="chip-list" aria-label="Lists">
          {lists.map((list) => (
            <li key={list.id}>
              <span className="chip chip--neutral chip--removable">
                {list.name}
                <button
                  type="button"
                  className="chip__remove"
                  aria-label={`Remove from ${list.name}`}
                  disabled={removeMember.isPending}
                  onClick={() => remove(list)}
                >
                  <Icon name="close" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="muted">None</span>
      )}
      <ListMenu
        label="Add to list"
        buttonClassName="btn btn--quiet"
        lists={all.data ?? []}
        checkedIds={lists.map((list) => list.id)}
        disabled={all.isPending}
        onPick={addTo}
        onCreate={addToNew}
      />
      {all.isError ? (
        <p className="inline-error">
          Could not load the lists.{' '}
          <button type="button" className="link link--button" onClick={() => void all.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {problem ? (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
