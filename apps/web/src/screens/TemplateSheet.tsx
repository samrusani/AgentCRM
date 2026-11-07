import { useMemo, useState } from 'react';
import { isVersionConflict } from '../api/client';
import { useStageCounts, useSwitchTemplate, useTemplates } from '../api/hooks';
import type { Pipeline, WorkspaceTemplate } from '../api/types';
import { ErrorState, Loading, Sheet, errorMessage } from '../components/common';
import { SheetSection } from '../components/record';
import { useUI } from '../lib/ui';

const REMOVE = '\u0000remove';

function countLabel(count: number): string {
  if (count === 0) return 'none';
  return `${count} ${count === 1 ? 'opportunity' : 'opportunities'}`;
}

// Prefill by position: the same index in the target template, clamped to its last stage.
function positionalTarget(index: number, target: WorkspaceTemplate): string {
  return target.stageNames[Math.min(index, target.stageNames.length - 1)] ?? '';
}

// Switches one pipeline to another template. Its name, stages, and deals change; other pipelines never do.
export function TemplateSheet({ pipeline, onClose }: { pipeline: Pipeline; onClose: () => void }) {
  const { pushToast } = useUI();
  const templates = useTemplates();
  const counts = useStageCounts(pipeline.id);
  const apply = useSwitchTemplate();

  const items = templates.data ?? [];
  const currentId = pipeline.template;
  const [choice, setChoice] = useState<string | null>(null);
  const selectedId = choice ?? currentId;
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const differs = selected !== null && selected.id !== currentId;

  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [replaceQualification, setReplaceQualification] = useState(true);

  const stages = pipeline.stages;
  const mapping = useMemo(() => {
    const result: Record<string, string> = {};
    if (!selected) return result;
    stages.forEach((stage, index) => {
      result[stage.id] = overrides[stage.id] ?? positionalTarget(index, selected);
    });
    return result;
  }, [stages, selected, overrides]);

  const loading = templates.isPending || (differs && counts.isPending);
  const loadError = templates.error ?? (differs ? counts.error : null);
  const version = pipeline.version;
  const countOf = (stageId: string) => counts.data?.[stageId] ?? 0;
  const unmapped = stages.filter((stage) => countOf(stage.id) > 0 && (!mapping[stage.id] || mapping[stage.id] === REMOVE));
  const canApply = differs && !loading && !loadError && unmapped.length === 0 && !apply.isPending;

  const choose = (id: string) => {
    setChoice(id);
    setOverrides({});
    apply.reset();
  };

  const submit = () => {
    if (!canApply || !selected) return;
    const stageMapping: Record<string, string> = {};
    for (const stage of stages) {
      const target = mapping[stage.id];
      if (target && target !== REMOVE) stageMapping[stage.id] = target;
    }
    apply.mutate(
      { pipelineId: pipeline.id, template: selected.id, stageMapping, replaceQualification, expectedVersion: version },
      {
        onSuccess: () => {
          pushToast(`Template changed to ${selected.name}.`);
          onClose();
        },
      },
    );
  };

  return (
    <Sheet
      title={`Change template for ${pipeline.name}`}
      subtitle="A template sets this pipeline's stage names. The qualification rules are shared by every pipeline."
      onClose={onClose}
    >
      {loading ? <Loading what="templates" /> : null}
      {loadError ? (
        <ErrorState
          what="the template details"
          error={loadError}
          onRetry={() => {
            void templates.refetch();
            void counts.refetch();
          }}
        />
      ) : null}

      {!loading && !loadError ? (
        <>
          <SheetSection title="Template">
            <div className="radio-stack" role="radiogroup" aria-label="Template">
              {items.map((item) => (
                <label key={item.id} className="radio template-option">
                  <input
                    type="radio"
                    name="workspace-template"
                    checked={selectedId === item.id}
                    onChange={() => choose(item.id)}
                  />
                  <span className="template-option__body">
                    <span className="template-option__name">
                      {item.name}
                      {item.id === currentId ? <span className="muted"> (current)</span> : null}
                    </span>
                    <span>{item.description}</span>
                    <span className="muted">{item.stageNames.join(', ')}</span>
                  </span>
                </label>
              ))}
            </div>
          </SheetSection>

          {differs && selected ? (
            <>
              <SheetSection title="Stages">
                <p className="muted">
                  Choose where each current stage goes in {selected.name}. Opportunities move with their stage. The
                  pipeline keeps its name.
                </p>
                <ul className="stage-map">
                  {stages.map((stage) => {
                    const count = countOf(stage.id);
                    const selectId = `template-stage-${stage.id}`;
                    return (
                      <li key={stage.id} className="stage-map__row">
                        <label className="stage-map__stage" htmlFor={selectId}>
                          <span>{stage.name}</span>
                          <span className="muted num">{countLabel(count)}</span>
                        </label>
                        <select
                          id={selectId}
                          className="input input--select"
                          value={mapping[stage.id] ?? ''}
                          onChange={(event) => setOverrides((prev) => ({ ...prev, [stage.id]: event.target.value }))}
                        >
                          {selected.stageNames.map((name, index) => (
                            <option key={`${name}-${index}`} value={name}>
                              {name}
                            </option>
                          ))}
                          {count === 0 ? <option value={REMOVE}>Remove</option> : null}
                        </select>
                      </li>
                    );
                  })}
                </ul>
              </SheetSection>

              <SheetSection title="Qualification rules">
                <label className="toggle template-check">
                  <input
                    type="checkbox"
                    checked={replaceQualification}
                    onChange={(event) => setReplaceQualification(event.target.checked)}
                  />
                  <span>Replace the qualification rules with the template defaults</span>
                </label>
                <p className="muted">
                  {replaceQualification
                    ? 'Your current qualification rules are overwritten with the defaults for this template.'
                    : 'Your current qualification rules stay as they are, even if they name tags this template does not use.'}
                </p>
              </SheetSection>
            </>
          ) : null}

          <p className="muted">
            People, organizations, opportunities, tags, claims, tasks, and history stay as they are. Only this
            pipeline's stages change, and the qualification rules when you choose to replace them. Other pipelines are
            not touched.
          </p>

          {!differs && selected ? (
            <p className="muted">{pipeline.name} already uses the {selected.name} template. Choose another to change it.</p>
          ) : null}
          {apply.isError ? (
            <p className="inline-error" role="alert">
              {isVersionConflict(apply.error)
                ? 'This pipeline changed since this sheet opened. Close the sheet and open it again, then retry. '
                : 'Could not change the template. '}
              {errorMessage(apply.error)} Nothing was changed.
            </p>
          ) : null}
          <div className="sheet-actions">
            <button type="button" className="btn btn--primary" onClick={submit} disabled={!canApply}>
              {apply.isPending ? 'Applying...' : 'Apply'}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </Sheet>
  );
}
