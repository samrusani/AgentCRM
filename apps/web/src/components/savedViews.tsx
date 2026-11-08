import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { isVersionConflict } from '../api/client';
import { useCreateView, useDeleteView, useRenameView, useViews } from '../api/hooks';
import type { SavedView, ViewScreen } from '../api/types';
import { Sheet, errorMessage } from './common';
import { viewUrl } from '../lib/views';
import { useUI } from '../lib/ui';

const MAX_NAME = 200;
const MANAGE = '__manage__';

// The Views select, the quiet Save view action, and the two small sheets. A view is a shortcut, not a mode: picking one
// navigates and the select goes straight back to its placeholder. The screen supplies the config and the plain sentence
// for its current state; this component never reads or writes screen state itself.
export function SavedViews({ screen, config, sentence }: { screen: ViewScreen; config: Record<string, string>; sentence: string }) {
  const views = useViews(screen);
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const items = views.data ?? [];

  const pick = (value: string) => {
    if (value === MANAGE) {
      setManaging(true);
      return;
    }
    const view = items.find((item) => item.id === value);
    if (view) navigate(viewUrl(screen, view.config));
  };

  return (
    <>
      <label className="sr-only" htmlFor={`views-${screen}`}>
        Saved views
      </label>
      {/* Always the placeholder: the select never shows a chosen view. */}
      <select id={`views-${screen}`} className="input input--select" value="" onChange={(event) => pick(event.target.value)}>
        <option value="">Views</option>
        {items.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
          </option>
        ))}
        <option value={MANAGE}>Manage</option>
      </select>
      <button type="button" className="btn btn--quiet" onClick={() => setSaving(true)} aria-haspopup="dialog">
        Save view
      </button>
      {saving ? <SaveViewSheet screen={screen} config={config} sentence={sentence} onClose={() => setSaving(false)} /> : null}
      {managing ? <ManageViewsSheet views={items} failed={views.isError} onClose={() => setManaging(false)} /> : null}
    </>
  );
}

function SaveViewSheet({ screen, config, sentence, onClose }: { screen: ViewScreen; config: Record<string, string>; sentence: string; onClose: () => void }) {
  const create = useCreateView();
  const { pushToast } = useUI();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const trimmed = name.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || create.isPending) return;
    setProblem(null);
    try {
      await create.mutateAsync({ name: trimmed, screen, config });
      pushToast(`Saved view ${trimmed}.`);
      onClose();
    } catch (error) {
      setProblem(`${errorMessage(error)} The view was not saved. Adjust the name and try again.`);
    }
  };

  return (
    <Sheet title="Save view" onClose={onClose}>
      <form className="connector__form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="field-label" htmlFor="save-view-name">
          Name
        </label>
        <input
          id="save-view-name"
          className="input"
          value={name}
          autoFocus
          required
          maxLength={MAX_NAME}
          aria-required="true"
          aria-describedby="save-view-sentence"
          onChange={(event) => setName(event.target.value)}
        />
        <p className="muted" id="save-view-sentence">
          {sentence}
        </p>
        {problem ? (
          <p className="inline-error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="connector__row">
          <button type="submit" className="btn btn--primary" disabled={!trimmed || create.isPending}>
            {create.isPending ? 'Saving...' : 'Save view'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function ManageViewsSheet({ views, failed, onClose }: { views: SavedView[]; failed: boolean; onClose: () => void }) {
  return (
    <Sheet title="Manage views" subtitle="Renaming or deleting a view changes nothing else." onClose={onClose}>
      {failed ? (
        <p className="inline-error" role="alert">
          The views could not be loaded. Close this sheet and try again.
        </p>
      ) : views.length === 0 ? (
        <p className="muted">No saved views for this screen yet.</p>
      ) : (
        <ul className="attr-list">
          {views.map((view) => (
            <ViewRow key={view.id} view={view} />
          ))}
        </ul>
      )}
      <div className="connector__row">
        <button type="button" className="btn btn--quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </Sheet>
  );
}

function ViewRow({ view }: { view: SavedView }) {
  const rename = useRenameView();
  const remove = useDeleteView();
  const [mode, setMode] = useState<'idle' | 'renaming' | 'deleting'>('idle');
  const [name, setName] = useState(view.name);
  // The version from when the rename started, so a change from another tab conflicts instead of being overwritten.
  const [openedVersion, setOpenedVersion] = useState(view.version);
  const [problem, setProblem] = useState<string | null>(null);
  const trimmed = name.trim();

  const startRename = () => {
    setName(view.name);
    setOpenedVersion(view.version);
    setProblem(null);
    setMode('renaming');
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || trimmed === view.name || rename.isPending) return;
    setProblem(null);
    try {
      await rename.mutateAsync({ id: view.id, expectedVersion: openedVersion, name: trimmed });
      setMode('idle');
    } catch (error) {
      setProblem(
        isVersionConflict(error)
          ? 'This view changed since you started. Cancel and try again. Nothing was renamed.'
          : `${errorMessage(error)} The view was not renamed.`,
      );
    }
  };

  const confirmDelete = async () => {
    setProblem(null);
    try {
      await remove.mutateAsync(view.id);
    } catch (error) {
      setProblem(`${errorMessage(error)} The view was not deleted.`);
      setMode('idle');
    }
  };

  return (
    <li className="view-row">
      {mode === 'renaming' ? (
        <form className="connector__row" onSubmit={(event) => void submitRename(event)} noValidate>
          <label className="sr-only" htmlFor={`rename-view-${view.id}`}>
            Name for {view.name}
          </label>
          <input
            id={`rename-view-${view.id}`}
            className="input"
            value={name}
            autoFocus
            required
            maxLength={MAX_NAME}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="btn btn--primary" disabled={!trimmed || trimmed === view.name || rename.isPending}>
            {rename.isPending ? 'Renaming...' : 'Rename view'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => setMode('idle')} disabled={rename.isPending}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="connector__row">
          <span className="view-row__name">{view.name}</span>
          {mode === 'deleting' ? (
            <span className="lift__confirm" role="alert">
              Delete {view.name}? Only the view is removed.
              <button type="button" className="btn btn--danger" disabled={remove.isPending} onClick={() => void confirmDelete()}>
                {remove.isPending ? 'Deleting...' : 'Delete view'}
              </button>
              <button type="button" className="btn" disabled={remove.isPending} onClick={() => setMode('idle')}>
                Keep view
              </button>
            </span>
          ) : (
            <>
              <button type="button" className="btn btn--quiet" onClick={startRename} aria-label={`Rename ${view.name}`}>
                Rename
              </button>
              <button type="button" className="btn btn--quiet" onClick={() => setMode('deleting')} aria-label={`Delete ${view.name}`}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
      {problem ? (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      ) : null}
    </li>
  );
}
