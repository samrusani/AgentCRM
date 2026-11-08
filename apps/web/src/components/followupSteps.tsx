import { useId, useState } from 'react';
import type { FollowupStep } from '../api/types';
import {
  FOLLOWUP_DEFAULT_WAIT_DAYS,
  FOLLOWUP_MAX_BODY,
  FOLLOWUP_MAX_STEPS,
  FOLLOWUP_MAX_WAIT_DAYS,
  FOLLOWUP_MIN_BODY,
  FOLLOWUP_MIN_WAIT_DAYS,
  followupCeilingProblem,
} from '../lib/mail';

// A step as typed. The wait stays text while it is edited so an empty field is not forced to a number.
export interface StepDraft {
  waitDays: string;
  body: string;
}

export function waitProblem(waitDays: string): string | null {
  const days = Number(waitDays);
  if (waitDays.trim() === '' || !Number.isInteger(days) || days < FOLLOWUP_MIN_WAIT_DAYS || days > FOLLOWUP_MAX_WAIT_DAYS) {
    return `Enter a whole number of days from ${FOLLOWUP_MIN_WAIT_DAYS} to ${FOLLOWUP_MAX_WAIT_DAYS}.`;
  }
  return null;
}

export function bodyProblem(body: string): string | null {
  const length = body.trim().length;
  if (length < FOLLOWUP_MIN_BODY) return `Write at least ${FOLLOWUP_MIN_BODY} characters.`;
  if (length > FOLLOWUP_MAX_BODY) {
    return `Shorten this to ${FOLLOWUP_MAX_BODY.toLocaleString()} characters or fewer.`;
  }
  return null;
}

function FollowupStepRow({
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

export function emptyStep(): StepDraft {
  return { waitDays: String(FOLLOWUP_DEFAULT_WAIT_DAYS), body: '' };
}

// Steps copied from a saved sequence become plain drafts the person can edit freely.
export function draftsFromSteps(steps: FollowupStep[]): StepDraft[] {
  return steps.map((step) => ({ waitDays: String(step.waitDays), body: step.body }));
}

// The text is sent as written, trimmed at the ends.
export function stepsFromDrafts(drafts: StepDraft[]): FollowupStep[] {
  return drafts.map((step) => ({ waitDays: Number(step.waitDays), body: step.body.trim() }));
}

export function draftsInvalid(drafts: StepDraft[]): boolean {
  return drafts.some((step) => waitProblem(step.waitDays) !== null || bodyProblem(step.body) !== null);
}

// The ceiling line for the steps as typed, or null when every wait is valid and the total is within it.
export function draftsCeilingProblem(drafts: StepDraft[]): string | null {
  if (drafts.some((step) => waitProblem(step.waitDays) !== null)) return null;
  return followupCeilingProblem(drafts.map((step) => Number(step.waitDays)));
}

// The step editor shared by prepare to send and the Settings sequence sheet: up to five steps, each with a wait and the
// exact text. It holds no state of its own beyond what each row needs to show a problem after the field was left.
export function FollowupStepsEditor({
  steps,
  disabled,
  onChange,
}: {
  steps: StepDraft[];
  disabled: boolean;
  onChange: (next: StepDraft[]) => void;
}) {
  const ceiling = draftsCeilingProblem(steps);
  return (
    <>
      {steps.length > 0 ? (
        <ol className="followup-steps" aria-label="Follow-ups">
          {steps.map((step, index) => (
            <FollowupStepRow
              key={index}
              index={index}
              step={step}
              disabled={disabled}
              onChange={(next) => onChange(steps.map((item, at) => (at === index ? next : item)))}
              onRemove={() => onChange(steps.filter((_item, at) => at !== index))}
            />
          ))}
        </ol>
      ) : null}
      {ceiling ? (
        <p className="inline-error" role="alert">
          {ceiling}
        </p>
      ) : null}
      {steps.length < FOLLOWUP_MAX_STEPS ? (
        <button type="button" className="btn btn--quiet" disabled={disabled} onClick={() => onChange([...steps, emptyStep()])}>
          Add a follow-up
        </button>
      ) : (
        <p className="muted">Five follow-ups is the most one send can carry.</p>
      )}
    </>
  );
}
