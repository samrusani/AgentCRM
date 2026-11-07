import { useState, type FormEvent } from 'react';
import { isVersionConflict } from '../api/client';
import { useRenameList } from '../api/hooks';
import type { PersonList } from '../api/types';
import { Sheet, errorMessage } from '../components/common';

const MAX_NAME = 200;

// Renames a list. Members stay as they are.
export function RenameListSheet({ list, onClose, onRenamed }: { list: PersonList; onClose: () => void; onRenamed: () => void }) {
  const rename = useRenameList();
  const [name, setName] = useState(list.name);
  // The version from when the sheet opened: a rename from another tab that lands mid-sheet then conflicts (409)
  // instead of being silently overwritten.
  const [openedVersion] = useState(list.version);
  const [problem, setProblem] = useState<string | null>(null);
  const trimmed = name.trim();
  const ready = Boolean(trimmed) && trimmed !== list.name && !rename.isPending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setProblem(null);
    try {
      await rename.mutateAsync({ id: list.id, expectedVersion: openedVersion, name: trimmed });
      onRenamed();
    } catch (error) {
      setProblem(
        isVersionConflict(error)
          ? 'This list changed since you opened this sheet. Close the sheet, open it again, then retry. Nothing was renamed.'
          : `${errorMessage(error)} The list was not renamed. Adjust the name and try again.`,
      );
    }
  };

  return (
    <Sheet title="Rename list" onClose={onClose}>
      <form className="connector__form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="field-label" htmlFor="rename-list-name">
          Name
        </label>
        <input
          id="rename-list-name"
          className="input"
          value={name}
          autoFocus
          required
          maxLength={MAX_NAME}
          aria-required="true"
          onChange={(event) => setName(event.target.value)}
        />
        {problem ? (
          <p className="inline-error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="connector__row">
          <button type="submit" className="btn btn--primary" disabled={!ready}>
            {rename.isPending ? 'Renaming...' : 'Rename list'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={onClose} disabled={rename.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}
