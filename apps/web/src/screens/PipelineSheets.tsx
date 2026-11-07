import { useState, type FormEvent } from 'react';
import { isVersionConflict } from '../api/client';
import { useCreatePipeline, useRenamePipeline, useTemplates } from '../api/hooks';
import type { Pipeline } from '../api/types';
import { ErrorState, Loading, Sheet, errorMessage } from '../components/common';

const MAX_NAME = 200;

// Creates a pipeline from a template. The template sets the stages; the name is the user's own.
export function NewPipelineSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (pipeline: Pipeline) => void }) {
  const templates = useTemplates();
  const create = useCreatePipeline();
  // The name field shows the chosen template's pipeline name until the user types in it; after that it is theirs.
  const [typedName, setTypedName] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const items = templates.data ?? [];
  const selectedId = choice ?? items[0]?.id ?? null;
  const name = typedName ?? items.find((item) => item.id === selectedId)?.pipelineName ?? '';
  const trimmed = name.trim();
  const ready = Boolean(trimmed) && Boolean(selectedId) && !create.isPending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !selectedId) return;
    setProblem(null);
    try {
      onCreated(await create.mutateAsync({ name: trimmed, template: selectedId }));
    } catch (error) {
      setProblem(`${errorMessage(error)} The pipeline was not created. Adjust the fields and try again.`);
    }
  };

  return (
    <Sheet title="New pipeline" subtitle="A pipeline holds its own stages and deals." onClose={onClose}>
      {templates.isPending ? <Loading what="templates" /> : null}
      {templates.isError ? (
        <ErrorState what="the templates" error={templates.error} onRetry={() => void templates.refetch()} />
      ) : null}
      {templates.data ? (
        <form className="connector__form" onSubmit={(event) => void submit(event)} noValidate>
          <label className="field-label" htmlFor="new-pipeline-name">
            Name
          </label>
          <input
            id="new-pipeline-name"
            className="input"
            value={name}
            autoFocus
            required
            maxLength={MAX_NAME}
            aria-required="true"
            onChange={(event) => setTypedName(event.target.value)}
          />
          <span className="field-label" id="new-pipeline-template-label">
            Template
          </span>
          <div className="radio-stack" role="radiogroup" aria-labelledby="new-pipeline-template-label">
            {items.map((item) => (
              <label key={item.id} className="radio template-option">
                <input
                  type="radio"
                  name="new-pipeline-template"
                  checked={selectedId === item.id}
                  onChange={() => setChoice(item.id)}
                />
                <span className="template-option__body">
                  <span className="template-option__name">{item.name}</span>
                  <span>{item.description}</span>
                  <span className="muted">{item.stageNames.join(', ')}</span>
                </span>
              </label>
            ))}
          </div>
          {problem ? (
            <p className="inline-error" role="alert">
              {problem}
            </p>
          ) : null}
          <div className="connector__row">
            <button type="submit" className="btn btn--primary" disabled={!ready}>
              {create.isPending ? 'Creating...' : 'Create pipeline'}
            </button>
            <button type="button" className="btn btn--quiet" onClick={onClose} disabled={create.isPending}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </Sheet>
  );
}

// Renames a pipeline. The template and stages stay as they are.
export function RenamePipelineSheet({ pipeline, onClose }: { pipeline: Pipeline; onClose: () => void }) {
  const rename = useRenamePipeline();
  const [name, setName] = useState(pipeline.name);
  // The version and name from when the sheet opened: an edit from another tab that lands mid-sheet then conflicts (409)
  // instead of being silently overwritten.
  const [openedVersion] = useState(pipeline.version);
  const [problem, setProblem] = useState<string | null>(null);
  const trimmed = name.trim();
  const ready = Boolean(trimmed) && trimmed !== pipeline.name && !rename.isPending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setProblem(null);
    try {
      await rename.mutateAsync({ id: pipeline.id, expectedVersion: openedVersion, name: trimmed });
      onClose();
    } catch (error) {
      setProblem(
        isVersionConflict(error)
          ? 'This pipeline changed since you opened this sheet. Close the sheet, open it again, then retry. Nothing was renamed.'
          : `${errorMessage(error)} The pipeline was not renamed.`,
      );
    }
  };

  return (
    <Sheet title="Rename pipeline" onClose={onClose}>
      <form className="connector__form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="field-label" htmlFor="rename-pipeline-name">
          Name
        </label>
        <input
          id="rename-pipeline-name"
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
            {rename.isPending ? 'Renaming...' : 'Rename pipeline'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={onClose} disabled={rename.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}
