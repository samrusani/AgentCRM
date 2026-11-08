import { useState, type FormEvent } from 'react';
import { isVersionConflict } from '../api/client';
import { useCreateSequence, useDeleteSequence, useSequences, useUpdateSequence } from '../api/hooks';
import type { Sequence } from '../api/types';
import { ErrorState, Loading, Sheet, errorMessage } from '../components/common';
import {
  draftsCeilingProblem,
  draftsFromSteps,
  draftsInvalid,
  emptyStep,
  FollowupStepsEditor,
  type StepDraft,
  stepsFromDrafts,
} from '../components/followupSteps';
import { sequenceSummary } from '../lib/mail';

const MAX_NAME = 200;

type SheetMode = { kind: 'new' } | { kind: 'rename'; sequence: Sequence } | { kind: 'steps'; sequence: Sequence };

// Follow-up sequences: saved, named presets of follow-up steps. A sequence only prefills the editor in prepare to send;
// it is never attached to a send, and nothing here sends anything.
export function SequencesSection() {
  const sequences = useSequences();
  const [sheet, setSheet] = useState<SheetMode | null>(null);

  return (
    <section className="section" aria-labelledby="settings-sequences">
      <div className="attr-group__head">
        <h2 className="section__title" id="settings-sequences">
          Follow-up sequences
        </h2>
        <button type="button" className="btn btn--quiet" onClick={() => setSheet({ kind: 'new' })} aria-haspopup="dialog">
          New sequence
        </button>
      </div>
      <p className="muted">
        Saved follow-up steps you can reuse. Choosing one in prepare to send copies its steps into the editor, where you
        can still change them.
      </p>
      {sequences.isPending ? <Loading what="sequences" /> : null}
      {sequences.isError ? (
        <ErrorState what="the sequences" error={sequences.error} onRetry={() => void sequences.refetch()} />
      ) : null}
      {sequences.data && sequences.data.length === 0 ? <p className="muted">No sequences yet.</p> : null}
      {sequences.data && sequences.data.length > 0 ? (
        <ul className="attr-list">
          {sequences.data.map((sequence) => (
            <SequenceRow
              key={sequence.id}
              sequence={sequence}
              onRename={() => setSheet({ kind: 'rename', sequence })}
              onEditSteps={() => setSheet({ kind: 'steps', sequence })}
            />
          ))}
        </ul>
      ) : null}
      {sheet ? <SequenceSheet mode={sheet} onClose={() => setSheet(null)} /> : null}
    </section>
  );
}

function SequenceRow({ sequence, onRename, onEditSteps }: { sequence: Sequence; onRename: () => void; onEditSteps: () => void }) {
  const remove = useDeleteSequence();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="attr-row">
      <div className="attr-row__main">
        <span>{sequence.name}</span>
        <p className="muted field__hint auto-row__sentence">{sequenceSummary(sequence.steps)}</p>
      </div>
      <div className="attr-row__actions">
        {confirming ? (
          <span className="lift__confirm" role="alert">
            Delete {sequence.name}? Sends you have already prepared and follow-ups that are running are not changed.
            <button
              type="button"
              className="btn btn--danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(sequence.id, { onSuccess: () => setConfirming(false) })}
            >
              {remove.isPending ? 'Deleting...' : 'Delete sequence'}
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
              Keep sequence
            </button>
          </span>
        ) : (
          <>
            <button type="button" className="btn btn--quiet" onClick={onRename} aria-haspopup="dialog" aria-label={`Rename ${sequence.name}`}>
              Rename
            </button>
            <button type="button" className="btn btn--quiet" onClick={onEditSteps} aria-haspopup="dialog" aria-label={`Edit steps of ${sequence.name}`}>
              Edit steps
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              aria-label={`Delete ${sequence.name}`}
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
          {errorMessage(remove.error)} The sequence was not deleted.
        </p>
      ) : null}
    </li>
  );
}

// One sheet for the three jobs: a new sequence (name and steps), a rename (name only), and edit steps (steps only).
function SequenceSheet({ mode, onClose }: { mode: SheetMode; onClose: () => void }) {
  const create = useCreateSequence();
  const update = useUpdateSequence();
  const pending = create.isPending || update.isPending;
  const sequence = mode.kind === 'new' ? null : mode.sequence;
  const showName = mode.kind !== 'steps';
  const showSteps = mode.kind !== 'rename';
  const [name, setName] = useState(sequence?.name ?? '');
  const [steps, setSteps] = useState<StepDraft[]>(
    sequence ? draftsFromSteps(sequence.steps) : [emptyStep()],
  );
  // The version from when the sheet opened: an edit from another tab that lands mid-sheet then conflicts (409).
  const [openedVersion] = useState(sequence?.version ?? 1);
  const [problem, setProblem] = useState<string | null>(null);
  const trimmedName = name.trim();
  const stepsReady = !showSteps || (steps.length > 0 && !draftsInvalid(steps) && draftsCeilingProblem(steps) === null);
  const ready = (!showName || trimmedName.length > 0) && stepsReady && !pending;
  const title = mode.kind === 'new' ? 'New sequence' : mode.kind === 'rename' ? 'Rename sequence' : 'Edit steps';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setProblem(null);
    try {
      if (sequence) {
        await update.mutateAsync({
          id: sequence.id,
          expectedVersion: openedVersion,
          fields: {
            ...(showName ? { name: trimmedName } : {}),
            ...(showSteps ? { steps: stepsFromDrafts(steps) } : {}),
          },
        });
      } else {
        await create.mutateAsync({ name: trimmedName, steps: stepsFromDrafts(steps) });
      }
      onClose();
    } catch (error) {
      setProblem(
        isVersionConflict(error)
          ? 'This sequence changed since you opened this sheet. Close the sheet, open it again, then retry. Nothing was saved.'
          : `${errorMessage(error)} The sequence was not saved. Adjust the fields and try again.`,
      );
    }
  };

  return (
    <Sheet title={title} onClose={onClose} wide={showSteps}>
      <form className="connector__form" onSubmit={(event) => void submit(event)} noValidate>
        {showName ? (
          <>
            <label className="field-label" htmlFor="sequence-sheet-name">
              Name
            </label>
            <input
              id="sequence-sheet-name"
              className="input"
              value={name}
              autoFocus
              required
              maxLength={MAX_NAME}
              aria-required="true"
              onChange={(event) => setName(event.target.value)}
            />
          </>
        ) : null}
        {showSteps ? (
          <>
            <FollowupStepsEditor steps={steps} disabled={pending} onChange={setSteps} />
            <p className="muted">
              A sequence only saves these steps. Nothing is sent, and sends you have already prepared are not changed.
            </p>
          </>
        ) : null}
        {problem ? (
          <p className="inline-error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="connector__row">
          <button type="submit" className="btn btn--primary" disabled={!ready}>
            {pending ? 'Saving...' : mode.kind === 'new' ? 'Create sequence' : 'Save'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={onClose} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}
