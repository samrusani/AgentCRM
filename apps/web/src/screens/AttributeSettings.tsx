import { useState, type FormEvent } from 'react';
import { isVersionConflict } from '../api/client';
import { useAttributeDefs, useCreateAttribute, useDeleteAttribute, useUpdateAttribute } from '../api/hooks';
import type { AttributeDef, AttributeEntityType, AttributeKind } from '../api/types';
import { ErrorState, Loading, Sheet, errorMessage } from '../components/common';

const MAX_LABEL = 200;
const MAX_DESCRIPTION = 500;

const KINDS: Array<{ value: AttributeKind; label: string; hint: string }> = [
  { value: 'text', label: 'Text', hint: 'Free text, up to 2000 characters.' },
  { value: 'number', label: 'Number', hint: 'Any number.' },
  { value: 'money', label: 'Money', hint: 'A whole amount with a currency.' },
];

const kindLabel = (kind: AttributeKind) => KINDS.find((entry) => entry.value === kind)?.label ?? kind;

const GROUPS: Array<{ entityType: AttributeEntityType; title: string; noun: string }> = [
  { entityType: 'person', title: 'People', noun: 'people' },
  { entityType: 'organization', title: 'Organizations', noun: 'organizations' },
];

// Custom attributes: typed fields a workspace adds to people and organizations. They show on the record sheets and are
// readable by agents, who can propose changes to them like any other field.
export function AttributesSection() {
  const [creating, setCreating] = useState<AttributeEntityType | null>(null);
  const [renaming, setRenaming] = useState<AttributeDef | null>(null);

  return (
    <section className="section" aria-labelledby="settings-attributes">
      <h2 className="section__title" id="settings-attributes">
        Custom attributes
      </h2>
      <p className="muted">
        Extra fields for people and organizations. They appear on each record, and agents can read them and propose changes to
        them.
      </p>
      {GROUPS.map((group) => (
        <AttributeGroup
          key={group.entityType}
          entityType={group.entityType}
          title={group.title}
          noun={group.noun}
          onNew={() => setCreating(group.entityType)}
          onRename={setRenaming}
        />
      ))}
      {creating ? <NewAttributeSheet entityType={creating} onClose={() => setCreating(null)} /> : null}
      {renaming ? <RenameAttributeSheet def={renaming} onClose={() => setRenaming(null)} /> : null}
    </section>
  );
}

function AttributeGroup({
  entityType,
  title,
  noun,
  onNew,
  onRename,
}: {
  entityType: AttributeEntityType;
  title: string;
  noun: string;
  onNew: () => void;
  onRename: (def: AttributeDef) => void;
}) {
  const defs = useAttributeDefs(entityType);
  const headingId = `settings-attributes-${entityType}`;
  return (
    <div className="attr-group" role="group" aria-labelledby={headingId}>
      <div className="attr-group__head">
        <h3 className="field__label" id={headingId}>
          {title}
        </h3>
        <button type="button" className="btn btn--quiet" onClick={onNew} aria-haspopup="dialog" aria-label={`New attribute for ${noun}`}>
          New attribute
        </button>
      </div>
      {defs.isPending ? <Loading what="attributes" /> : null}
      {defs.isError ? <ErrorState what="the attributes" error={defs.error} onRetry={() => void defs.refetch()} /> : null}
      {defs.data && defs.data.length === 0 ? <p className="muted">No custom attributes for {noun} yet.</p> : null}
      {defs.data && defs.data.length > 0 ? (
        <ul className="attr-list">
          {defs.data.map((def) => (
            <AttributeRow key={def.id} def={def} onRename={() => onRename(def)} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AttributeRow({ def, onRename }: { def: AttributeDef; onRename: () => void }) {
  const remove = useDeleteAttribute();
  const [confirming, setConfirming] = useState(false);
  const count = def.valueCount;
  return (
    <li className="attr-row">
      <div className="attr-row__main">
        <span>{def.label}</span> <span className="muted">{kindLabel(def.kind)}</span>
        {def.description ? <p className="muted field__hint">{def.description}</p> : null}
      </div>
      <div className="attr-row__actions">
        {confirming ? (
          <span className="lift__confirm" role="alert">
            Delete {def.label}? Its {count} saved {count === 1 ? 'value is' : 'values are'} deleted with it.
            <button
              type="button"
              className="btn btn--danger"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(def.id, {
                  onSuccess: () => setConfirming(false),
                })
              }
            >
              {remove.isPending ? 'Deleting...' : 'Delete attribute'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={remove.isPending}
              onClick={() => {
                setConfirming(false);
                remove.reset();
              }}
            >
              Keep attribute
            </button>
          </span>
        ) : (
          <>
            <button type="button" className="btn btn--quiet" onClick={onRename} aria-haspopup="dialog" aria-label={`Rename ${def.label}`}>
              Rename
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              aria-label={`Delete ${def.label}`}
              onClick={() => {
                remove.reset();
                setConfirming(true);
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
      {remove.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(remove.error)} The attribute was not deleted.
        </p>
      ) : null}
    </li>
  );
}

function NewAttributeSheet({ entityType, onClose }: { entityType: AttributeEntityType; onClose: () => void }) {
  const create = useCreateAttribute();
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<AttributeKind>('text');
  const [description, setDescription] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const trimmed = label.trim();
  const ready = Boolean(trimmed) && !create.isPending;
  const noun = entityType === 'person' ? 'people' : 'organizations';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setProblem(null);
    try {
      await create.mutateAsync({
        entityType,
        label: trimmed,
        kind,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onClose();
    } catch (error) {
      setProblem(`${errorMessage(error)} The attribute was not created. Adjust the fields and try again.`);
    }
  };

  return (
    <Sheet title="New attribute" subtitle={`A field on every record of ${noun}.`} onClose={onClose}>
      <form className="connector__form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="field-label" htmlFor="new-attribute-label">
          Label
        </label>
        <input
          id="new-attribute-label"
          className="input"
          value={label}
          autoFocus
          required
          maxLength={MAX_LABEL}
          aria-required="true"
          onChange={(event) => setLabel(event.target.value)}
        />
        <span className="field-label" id="new-attribute-kind-label">
          Kind
        </span>
        <div className="radio-stack" role="radiogroup" aria-labelledby="new-attribute-kind-label">
          {KINDS.map((entry) => (
            <label key={entry.value} className="radio">
              <input type="radio" name="new-attribute-kind" checked={kind === entry.value} onChange={() => setKind(entry.value)} />
              <span>
                {entry.label} <span className="muted">{entry.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="muted">The kind cannot be changed after the attribute is created.</p>
        <label className="field-label" htmlFor="new-attribute-description">
          Description (optional)
        </label>
        <input
          id="new-attribute-description"
          className="input"
          value={description}
          maxLength={MAX_DESCRIPTION}
          aria-describedby="new-attribute-description-note"
          onChange={(event) => setDescription(event.target.value)}
        />
        <p className="muted" id="new-attribute-description-note">
          One sentence. It shows under the field on the sheet and tells agents what to put there.
        </p>
        {problem ? (
          <p className="inline-error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="connector__row">
          <button type="submit" className="btn btn--primary" disabled={!ready}>
            {create.isPending ? 'Creating...' : 'Create attribute'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}

// Renames an attribute or edits its description. The kind and the key behind agent edits stay as they are.
function RenameAttributeSheet({ def, onClose }: { def: AttributeDef; onClose: () => void }) {
  const update = useUpdateAttribute();
  const [label, setLabel] = useState(def.label);
  const [description, setDescription] = useState(def.description ?? '');
  // The version from when the sheet opened: an edit from another tab that lands mid-sheet then conflicts (409).
  const [openedVersion] = useState(def.version);
  const [problem, setProblem] = useState<string | null>(null);
  const trimmed = label.trim();
  const trimmedDescription = description.trim();
  const changed = trimmed !== def.label || trimmedDescription !== (def.description ?? '');
  const ready = Boolean(trimmed) && changed && !update.isPending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setProblem(null);
    try {
      await update.mutateAsync({
        id: def.id,
        expectedVersion: openedVersion,
        fields: { label: trimmed, description: trimmedDescription === '' ? null : trimmedDescription },
      });
      onClose();
    } catch (error) {
      setProblem(
        isVersionConflict(error)
          ? 'This attribute changed since you opened this sheet. Close the sheet, open it again, then retry. Nothing was renamed.'
          : `${errorMessage(error)} The attribute was not renamed.`,
      );
    }
  };

  return (
    <Sheet title="Rename attribute" subtitle={`${kindLabel(def.kind)}. Saved values stay as they are.`} onClose={onClose}>
      <form className="connector__form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="field-label" htmlFor="rename-attribute-label">
          Label
        </label>
        <input
          id="rename-attribute-label"
          className="input"
          value={label}
          autoFocus
          required
          maxLength={MAX_LABEL}
          aria-required="true"
          onChange={(event) => setLabel(event.target.value)}
        />
        <label className="field-label" htmlFor="rename-attribute-description">
          Description (optional)
        </label>
        <input
          id="rename-attribute-description"
          className="input"
          value={description}
          maxLength={MAX_DESCRIPTION}
          onChange={(event) => setDescription(event.target.value)}
        />
        {problem ? (
          <p className="inline-error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="connector__row">
          <button type="submit" className="btn btn--primary" disabled={!ready}>
            {update.isPending ? 'Saving...' : 'Save'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={onClose} disabled={update.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}
