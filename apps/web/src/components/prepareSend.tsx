import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMailReadiness, useStageSend } from '../api/hooks';
import type { SendExcluded, StageSendInput } from '../api/types';
import {
  FOLLOWUP_DEFAULT_WAIT_DAYS,
  FOLLOWUP_MAX_BODY,
  FOLLOWUP_MAX_STEPS,
  FOLLOWUP_MAX_WAIT_DAYS,
  FOLLOWUP_MIN_BODY,
  FOLLOWUP_MIN_WAIT_DAYS,
  messageCountLabel,
  parseSendReviewPayload,
} from '../lib/mail';
import { errorMessage } from './common';
import { ExcludedList } from './sendReview';

export interface StagedNotice {
  messageCount: number;
  excluded: SendExcluded[];
}

// A step as typed. The wait stays text while it is edited so an empty field is not forced to a number.
interface StepDraft {
  waitDays: string;
  body: string;
}

function waitProblem(waitDays: string): string | null {
  const days = Number(waitDays);
  if (waitDays.trim() === '' || !Number.isInteger(days) || days < FOLLOWUP_MIN_WAIT_DAYS || days > FOLLOWUP_MAX_WAIT_DAYS) {
    return `Enter a whole number of days from ${FOLLOWUP_MIN_WAIT_DAYS} to ${FOLLOWUP_MAX_WAIT_DAYS}.`;
  }
  return null;
}

function bodyProblem(body: string): string | null {
  const length = body.trim().length;
  if (length < FOLLOWUP_MIN_BODY) return `Write at least ${FOLLOWUP_MIN_BODY} characters.`;
  if (length > FOLLOWUP_MAX_BODY) {
    return `Shorten this to ${FOLLOWUP_MAX_BODY.toLocaleString()} characters or fewer.`;
  }
  return null;
}

function FollowupStepEditor({
  index,
  step,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  step: StepDraft;
  disabled: boolean;
  onChange: (next: StepDraft) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const [touched, setTouched] = useState(false);
  const wait = waitProblem(step.waitDays);
  const body = bodyProblem(step.body);
  const length = step.body.trim().length;
  const showBody = body !== null && (touched || length > 0);

  return (
    <li className="followup-step">
      <div className="followup-step__head">
        <span className="cell-name">Follow-up {index + 1}</span>
        <button
          type="button"
          className="btn btn--quiet"
          disabled={disabled}
          onClick={onRemove}
          aria-label={`Remove follow-up ${index + 1}`}
        >
          Remove
        </button>
      </div>
      <div className="followup-step__wait">
        <input
          id={`${id}-days`}
          className="input input--number"
          type="number"
          inputMode="numeric"
          min={FOLLOWUP_MIN_WAIT_DAYS}
          max={FOLLOWUP_MAX_WAIT_DAYS}
          step={1}
          value={step.waitDays}
          disabled={disabled}
          aria-invalid={wait !== null}
          aria-describedby={wait ? `${id}-days-error` : undefined}
          onChange={(event) => onChange({ ...step, waitDays: event.target.value })}
        />
        <label htmlFor={`${id}-days`}>days after the last send</label>
        <span className="muted">weekends skipped</span>
      </div>
      {wait ? (
        <p className="inline-error" id={`${id}-days-error`} role="alert">
          {wait}
        </p>
      ) : null}
      <div>
        <label className="field-label" htmlFor={`${id}-body`}>
          Exact text of follow-up {index + 1}
        </label>
        <textarea
          id={`${id}-body`}
          className="input"
          rows={5}
          value={step.body}
          disabled={disabled}
          aria-invalid={showBody}
          aria-describedby={`${id}-count${showBody ? ` ${id}-body-error` : ''}`}
          onChange={(event) => onChange({ ...step, body: event.target.value })}
          onBlur={() => setTouched(true)}
        />
        <span
          className={`followup-step__count num ${body !== null && length > 0 ? 'is-overdue' : 'muted'}`}
          id={`${id}-count`}
          aria-live="polite"
        >
          {length.toLocaleString()} of {FOLLOWUP_MAX_BODY.toLocaleString()} characters, at least {FOLLOWUP_MIN_BODY}
        </span>
        {showBody ? (
          <p className="inline-error" id={`${id}-body-error`} role="alert">
            {body}
          </p>
        ) : null}
      </div>
    </li>
  );
}

// Starts the send review for saved drafts. This only creates a review on Today: nothing is sent until the exact
// messages are approved there.
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
  const navigate = useNavigate();
  const noteId = useId();
  const [steps, setSteps] = useState<StepDraft[]>([]);

  const blocked = readiness.state === 'blocked' ? readiness : null;
  const stepsInvalid = steps.some((step) => waitProblem(step.waitDays) !== null || bodyProblem(step.body) !== null);
  const disabled = readiness.state !== 'ready' || stage.isPending || stepsInvalid;

  const updateStep = (index: number, next: StepDraft) =>
    setSteps((current) => current.map((step, at) => (at === index ? next : step)));

  const prepare = () => {
    if (disabled) return;
    // Follow-ups ride along only when at least one valid step exists. The text is sent as written, trimmed at the ends.
    const request: StageSendInput =
      steps.length > 0
        ? {
            ...input,
            followups: { steps: steps.map((step) => ({ waitDays: Number(step.waitDays), body: step.body.trim() })) },
          }
        : input;
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
      {steps.length > 0 ? (
        <>
          <ol className="followup-steps" aria-label="Follow-ups">
            {steps.map((step, index) => (
              <FollowupStepEditor
                key={index}
                index={index}
                step={step}
                disabled={stage.isPending}
                onChange={(next) => updateStep(index, next)}
                onRemove={() => setSteps((current) => current.filter((_step, at) => at !== index))}
              />
            ))}
          </ol>
          <p className="muted">The same text goes to every recipient, word for word. Nothing is personalized.</p>
        </>
      ) : null}
      {steps.length < FOLLOWUP_MAX_STEPS ? (
        <button
          type="button"
          className="btn btn--quiet"
          disabled={stage.isPending}
          onClick={() =>
            setSteps((current) => [...current, { waitDays: String(FOLLOWUP_DEFAULT_WAIT_DAYS), body: '' }])
          }
        >
          {steps.length === 0 ? 'Add a follow-up' : 'Add a second follow-up'}
        </button>
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
