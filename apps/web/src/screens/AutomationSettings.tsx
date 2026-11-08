import { useMemo, useState, type FormEvent } from 'react';
import { isVersionConflict } from '../api/client';
import {
  useAutomations,
  useCreateAutomation,
  useDeleteAutomation,
  usePipelines,
  useUpdateAutomation,
} from '../api/hooks';
import type { Automation, AutomationTriggerKind, Pipeline } from '../api/types';
import { ErrorState, Loading, Sheet, errorMessage } from '../components/common';

const MAX_NAME = 200;
const MAX_TITLE = 200;
const MAX_DAYS = 365;

const TRIGGERS: Array<{ value: AutomationTriggerKind; label: string }> = [
  { value: 'stage_entered', label: 'A deal enters a stage' },
  { value: 'person_promoted', label: 'A person becomes a relationship' },
];

function dueText(days: number): string {
  if (days === 0) return 'due the same day';
  return `due in ${days} ${days === 1 ? 'day' : 'days'}`;
}

// The plain sentence for a rule. A pipeline or stage that no longer exists reads as such instead of a blank.
export function automationSentence(automation: Automation, pipelines: Pipeline[] | undefined): string {
  const due = dueText(automation.actionConfig.dueInDays);
  if (automation.triggerKind === 'person_promoted') return `When a person becomes a relationship, create a task ${due}.`;
  const pipeline = pipelines?.find((item) => item.id === automation.triggerConfig.pipelineId);
  const stage = pipeline?.stages.find((item) => item.id === automation.triggerConfig.stageId);
  if (!pipeline || !stage) return `When a deal enters a stage that no longer exists, create a task ${due}.`;
  return `When a deal enters ${stage.name} in ${pipeline.name}, create a task ${due}.`;
}

// Automations: rules that create a task when a deal enters a stage or a person becomes a relationship. A task is the
// whole effect; a rule never edits a record or sends anything.
export function AutomationsSection() {
  const automations = useAutomations();
  const pipelines = usePipelines();
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);

  return (
    <section className="section" aria-labelledby="settings-automations">
      <div className="attr-group__head">
        <h2 className="section__title" id="settings-automations">
          Automations
        </h2>
        <button type="button" className="btn btn--quiet" onClick={() => setEditing('new')} aria-haspopup="dialog">
          New automation
        </button>
      </div>
      <p className="muted">Rules that create a task when something happens. Tasks appear in Today like any other task.</p>
      {automations.isPending ? <Loading what="automations" /> : null}
      {automations.isError ? (
        <ErrorState what="the automations" error={automations.error} onRetry={() => void automations.refetch()} />
      ) : null}
      {automations.data && automations.data.length === 0 ? <p className="muted">No automations yet.</p> : null}
      {automations.data && automations.data.length > 0 ? (
        <ul className="attr-list">
          {automations.data.map((automation) => (
            <AutomationRow
              key={automation.id}
              automation={automation}
              pipelines={pipelines.data}
              onEdit={() => setEditing(automation)}
            />
          ))}
        </ul>
      ) : null}
      {editing ? (
        <AutomationSheet automation={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </section>
  );
}

function AutomationRow({
  automation,
  pipelines,
  onEdit,
}: {
  automation: Automation;
  pipelines: Pipeline[] | undefined;
  onEdit: () => void;
}) {
  const update = useUpdateAutomation();
  const remove = useDeleteAutomation();
  const [confirming, setConfirming] = useState(false);
  const fired = automation.firedCount;
  // A rule switched off by a deletion stays off until it is edited to name a pipeline and stage that exist.
  const locked = automation.disabledReason !== null;

  return (
    <li className="attr-row">
      <div className="attr-row__main">
        <span>{automation.name}</span>
        <p className="muted field__hint auto-row__sentence">{automationSentence(automation, pipelines)}</p>
        {automation.disabledReason ? (
          <p className="muted field__hint">Disabled. {automation.disabledReason} Edit it to choose a stage that exists.</p>
        ) : null}
      </div>
      <div className="auto-row__meta">
        <label className="toggle">
          <input
            type="checkbox"
            checked={automation.enabled}
            disabled={update.isPending || locked}
            aria-label={`Enabled: ${automation.name}`}
            onChange={(event) =>
              update.mutate({ id: automation.id, expectedVersion: automation.version, fields: { enabled: event.target.checked } })
            }
          />
          <span>{automation.enabled ? 'On' : 'Off'}</span>
        </label>
        <span className="muted">{fired === 1 ? 'Fired 1 time' : `Fired ${fired} times`}</span>
      </div>
      <div className="attr-row__actions">
        {confirming ? (
          <span className="lift__confirm" role="alert">
            Delete {automation.name}? Tasks it already created stay.
            <button
              type="button"
              className="btn btn--danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(automation.id, { onSuccess: () => setConfirming(false) })}
            >
              {remove.isPending ? 'Deleting...' : 'Delete automation'}
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
              Keep automation
            </button>
          </span>
        ) : (
          <>
            <button type="button" className="btn btn--quiet" onClick={onEdit} aria-haspopup="dialog" aria-label={`Edit ${automation.name}`}>
              Edit
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              aria-label={`Delete ${automation.name}`}
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
      {update.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(update.error)} The automation did not change.
        </p>
      ) : null}
      {remove.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(remove.error)} The automation was not deleted.
        </p>
      ) : null}
    </li>
  );
}

// One sheet for both creating and editing. The trigger kind is fixed once the rule exists.
function AutomationSheet({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  const pipelines = usePipelines();
  const create = useCreateAutomation();
  const update = useUpdateAutomation();
  const pending = create.isPending || update.isPending;
  const editing = automation !== null;
  const [name, setName] = useState(automation?.name ?? '');
  const [kind, setKind] = useState<AutomationTriggerKind>(automation?.triggerKind ?? 'stage_entered');
  const [pipelineId, setPipelineId] = useState(automation?.triggerConfig.pipelineId ?? '');
  const [stageId, setStageId] = useState(automation?.triggerConfig.stageId ?? '');
  const [taskTitle, setTaskTitle] = useState(automation?.actionConfig.taskTitle ?? '');
  const [dueInDays, setDueInDays] = useState(String(automation?.actionConfig.dueInDays ?? 0));
  // The version from when the sheet opened: an edit from another tab that lands mid-sheet then conflicts (409).
  const [openedVersion] = useState(automation?.version ?? 1);
  const [problem, setProblem] = useState<string | null>(null);

  const pipeline = pipelines.data?.find((item) => item.id === pipelineId) ?? pipelines.data?.[0];
  const stages = useMemo(() => [...(pipeline?.stages ?? [])].sort((a, b) => a.seq - b.seq), [pipeline]);
  const selectedStage = stages.find((item) => item.id === stageId) ?? stages[0];
  const trimmedName = name.trim();
  const trimmedTitle = taskTitle.trim();
  const days = dueInDays.trim() === '' ? NaN : Number(dueInDays);
  const daysValid = Number.isInteger(days) && days >= 0 && days <= MAX_DAYS;
  const triggerReady = kind === 'person_promoted' || Boolean(pipeline && selectedStage);
  const ready = Boolean(trimmedName) && Boolean(trimmedTitle) && daysValid && triggerReady && !pending;
  const subject = kind === 'stage_entered' ? "the deal's name" : "the person's name";

  // Stages belong to one pipeline, so choosing another pipeline resets the stage to that pipeline's first.
  const pickPipeline = (id: string) => {
    setPipelineId(id);
    setStageId('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setProblem(null);
    const triggerConfig = kind === 'stage_entered' && pipeline && selectedStage ? { pipelineId: pipeline.id, stageId: selectedStage.id } : {};
    const actionConfig = { taskTitle: trimmedTitle, dueInDays: days };
    try {
      if (automation) {
        await update.mutateAsync({
          id: automation.id,
          expectedVersion: openedVersion,
          // Saving a rule that a deletion switched off turns it back on, because the trigger was just chosen again.
          fields: { name: trimmedName, triggerConfig, actionConfig, ...(automation.disabledReason ? { enabled: true } : {}) },
        });
      } else {
        await create.mutateAsync({ name: trimmedName, triggerKind: kind, triggerConfig, actionConfig });
      }
      onClose();
    } catch (error) {
      setProblem(
        isVersionConflict(error)
          ? 'This automation changed since you opened this sheet. Close the sheet, open it again, then retry. Nothing was saved.'
          : `${errorMessage(error)} The automation was not saved. Adjust the fields and try again.`,
      );
    }
  };

  return (
    <Sheet title={editing ? 'Edit automation' : 'New automation'} onClose={onClose}>
      {pipelines.isPending ? <Loading what="pipelines" /> : null}
      {pipelines.isError ? (
        <ErrorState what="the pipelines" error={pipelines.error} onRetry={() => void pipelines.refetch()} />
      ) : null}
      {pipelines.data ? (
        <form className="connector__form" onSubmit={(event) => void submit(event)} noValidate>
          {automation?.disabledReason ? (
            <p className="muted" role="status">
              The stage this rule pointed at was deleted. Choose a new pipeline and stage before saving.
            </p>
          ) : null}
          <label className="field-label" htmlFor="automation-name">
            Name
          </label>
          <input
            id="automation-name"
            className="input"
            value={name}
            autoFocus
            required
            maxLength={MAX_NAME}
            aria-required="true"
            onChange={(event) => setName(event.target.value)}
          />
          <label className="field-label" htmlFor="automation-trigger">
            When
          </label>
          <select
            id="automation-trigger"
            className="input input--select"
            value={kind}
            disabled={editing}
            onChange={(event) => setKind(event.target.value as AutomationTriggerKind)}
          >
            {TRIGGERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {editing ? <p className="muted">The trigger cannot be changed after the automation is created.</p> : null}
          {kind === 'stage_entered' ? (
            <>
              <label className="field-label" htmlFor="automation-pipeline">
                Pipeline
              </label>
              <select
                id="automation-pipeline"
                className="input input--select"
                value={pipeline?.id ?? ''}
                onChange={(event) => pickPipeline(event.target.value)}
              >
                {pipelines.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <label className="field-label" htmlFor="automation-stage">
                Stage
              </label>
              <select
                id="automation-stage"
                className="input input--select"
                value={selectedStage?.id ?? ''}
                onChange={(event) => setStageId(event.target.value)}
              >
                {stages.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <label className="field-label" htmlFor="automation-title">
            Task title
          </label>
          <input
            id="automation-title"
            className="input"
            value={taskTitle}
            required
            maxLength={MAX_TITLE}
            aria-required="true"
            aria-describedby="automation-title-note"
            onChange={(event) => setTaskTitle(event.target.value)}
          />
          <p className="muted" id="automation-title-note">
            {'Write {name} to insert '}
            {subject}.
          </p>
          <label className="field-label" htmlFor="automation-days">
            Due in days
          </label>
          <input
            id="automation-days"
            className="input input--number num"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_DAYS}
            step={1}
            value={dueInDays}
            aria-invalid={!daysValid}
            aria-describedby="automation-days-note"
            onChange={(event) => setDueInDays(event.target.value)}
          />
          <p className="muted" id="automation-days-note">
            {daysValid ? '0 means the same day.' : `Enter a whole number from 0 to ${MAX_DAYS}. 0 means the same day.`}
          </p>
          <p className="muted">An automation only creates a task. It never edits records or sends anything.</p>
          {problem ? (
            <p className="inline-error" role="alert">
              {problem}
            </p>
          ) : null}
          <div className="connector__row">
            <button type="submit" className="btn btn--primary" disabled={!ready}>
              {pending ? 'Saving...' : editing ? 'Save' : 'Create automation'}
            </button>
            <button type="button" className="btn btn--quiet" onClick={onClose} disabled={pending}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </Sheet>
  );
}
