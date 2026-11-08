import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCreateSequence, useMailReadiness, useSequences, useStageSend } from '../api/hooks';
import type { SendExcluded, StageSendInput } from '../api/types';
import { messageCountLabel, parseSendReviewPayload, sequenceSummary } from '../lib/mail';
import { errorMessage, Sheet } from './common';
import {
  draftsCeilingProblem,
  draftsFromSteps,
  draftsInvalid,
  FollowupStepsEditor,
  type StepDraft,
  stepsFromDrafts,
} from './followupSteps';
import { ExcludedList } from './sendReview';

export interface StagedNotice {
  messageCount: number;
  excluded: SendExcluded[];
}

// A small sheet that saves the steps in the editor as a named preset. It saves nothing else: no recipient, no draft.
function SaveSequenceSheet({ steps, onClose, onSaved }: { steps: StepDraft[]; onClose: () => void; onSaved: (name: string) => void }) {
  const create = useCreateSequence();
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const ready = trimmed.length > 0 && !create.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    create.mutate(
      { name: trimmed, steps: stepsFromDrafts(steps) },
      {
        onSuccess: () => {
          onSaved(trimmed);
          onClose();
        },
      },
    );
  };
  return (
    <Sheet title="Save as sequence" onClose={onClose}>
      <form className="connector__form" onSubmit={submit} noValidate>
        <p className="muted">
          Saves these {steps.length === 1 ? 'step' : 'steps'} ({sequenceSummary(stepsFromDrafts(steps))}) so you can reuse
          them. Nothing is sent, and sends you have already prepared are not changed.
        </p>
        <label className="field-label" htmlFor="sequence-name">
          Name
        </label>
        <input
          id="sequence-name"
          className="input"
          value={name}
          autoFocus
          required
          maxLength={200}
          aria-required="true"
          onChange={(event) => setName(event.target.value)}
        />
        {create.isError ? (
          <p className="inline-error" role="alert">
            {errorMessage(create.error)} The sequence was not saved.
          </p>
        ) : null}
        <div className="connector__row">
          <button type="submit" className="btn btn--primary" disabled={!ready}>
            {create.isPending ? 'Saving...' : 'Save sequence'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}

// Starts the send review for saved drafts. This only creates a review on Today: nothing is sent until the exact
// messages are approved there. A sequence only prefills the editor; the send stages whatever the editor holds.
export function PrepareToSend({
  label,
  input,
  quiet = false,
}: {
  label: string;
  input: StageSendInput;
  quiet?: boolean;
}) {
  const readiness = useMailReadiness();
  const stage = useStageSend();
  const sequences = useSequences();
  const navigate = useNavigate();
  const noteId = useId();
  const selectId = useId();
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAs, setSavedAs] = useState<string | null>(null);

  const blocked = readiness.state === 'blocked' ? readiness : null;
  const stepsInvalid = draftsInvalid(steps);
  const overCeiling = draftsCeilingProblem(steps) !== null;
  const disabled = readiness.state !== 'ready' || stage.isPending || stepsInvalid || overCeiling;
  const saved = sequences.data ?? [];

  const changeSteps = (next: StepDraft[]) => {
    setSteps(next);
    setSavedAs(null);
    if (next.length === 0) setCopiedFrom(null);
  };

  const prepare = () => {
    if (disabled) return;
    // Follow-ups ride along only when at least one valid step exists.
    const request: StageSendInput = steps.length > 0 ? { ...input, followups: { steps: stepsFromDrafts(steps) } } : input;
    stage.mutate(request, {
      onSuccess: (result) => {
        if (!result.approval) return;
        const messageCount = parseSendReviewPayload(result.approval.payload).messages.length;
        const notice: StagedNotice = { messageCount, excluded: result.excluded };
        navigate('/today', { state: { staged: notice } });
      },
    });
  };

  // No approval came back: everything was left out, and the reasons stay on screen here.
  const nothingStaged = stage.isSuccess && stage.data.approval === null;

  return (
    <div className="prepare-send">
      <FollowupStepsEditor steps={steps} disabled={stage.isPending} onChange={changeSteps} />
      {saved.length > 0 ? (
        <div className="prepare-send__sequence">
          <label className="field-label" htmlFor={selectId}>
            Use a sequence
          </label>
          <select
            id={selectId}
            className="input input--select"
            value=""
            disabled={stage.isPending}
            onChange={(event) => {
              const chosen = saved.find((item) => item.id === event.target.value);
              if (!chosen) return;
              setSteps(draftsFromSteps(chosen.steps));
              setCopiedFrom(chosen.name);
              setSavedAs(null);
            }}
          >
            <option value="">Choose a sequence</option>
            {saved.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {copiedFrom && steps.length > 0 ? (
            <p className="muted" role="status">
              Copied the steps from {copiedFrom}. You can edit them freely; the sequence itself does not change.
            </p>
          ) : null}
        </div>
      ) : null}
      {steps.length > 0 ? (
        <>
          <p className="muted">The same text goes to every recipient, word for word. Nothing is personalized.</p>
          <button
            type="button"
            className="btn btn--quiet"
            disabled={stage.isPending || stepsInvalid || overCeiling}
            onClick={() => setSaving(true)}
            aria-haspopup="dialog"
          >
            Save as sequence
          </button>
          {savedAs ? (
            <p className="muted" role="status">
              Saved as {savedAs}.
            </p>
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        className={quiet ? 'btn btn--quiet' : 'btn'}
        onClick={prepare}
        disabled={disabled}
        aria-describedby={blocked ? noteId : undefined}
      >
        {stage.isPending ? 'Preparing...' : label}
      </button>
      {blocked ? (
        <p className="muted" id={noteId}>
          {blocked.message}{' '}
          {blocked.settingsLink ? (
            <Link className="link" to="/settings/connectors">
              Open Settings
            </Link>
          ) : null}
        </p>
      ) : null}
      {stage.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(stage.error)} Nothing was prepared.
        </p>
      ) : null}
      {nothingStaged ? (
        <div role="status">
          <p>No message can be sent. Everyone in this selection was left out.</p>
          <ExcludedList excluded={stage.data.excluded} />
        </div>
      ) : null}
      {saving ? <SaveSequenceSheet steps={steps} onClose={() => setSaving(false)} onSaved={setSavedAs} /> : null}
    </div>
  );
}

export function StagedBanner({ notice, onDismiss }: { notice: StagedNotice; onDismiss: () => void }) {
  return (
    <section className="staged-banner" aria-label="Send review prepared" role="status">
      <p>
        <span className="cell-name num">{messageCountLabel(notice.messageCount)}</span> prepared for review below.
        Nothing is sent until you approve the exact text.
        {notice.excluded.length > 0 ? ' Some people were left out:' : ''}
      </p>
      <ExcludedList excluded={notice.excluded} />
      <button type="button" className="btn btn--quiet" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}
