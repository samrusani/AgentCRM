import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useCreateOpportunity, usePipelines } from '../api/hooks';
import { ErrorState, Loading, Sheet, errorMessage } from '../components/common';
import { RecordPicker, type PickedRecord } from '../components/RecordPicker';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY'];
const MAX_AMOUNT = 1_000_000_000_000;

export interface NewOpportunityPrefill {
  person?: PickedRecord | null;
  organization?: PickedRecord | null;
}

// An empty amount is fine. A filled one must be a whole number the server accepts.
function parseAmount(text: string): { value: number | null; valid: boolean } {
  const trimmed = text.trim();
  if (!trimmed) return { value: null, valid: true };
  const value = Number(trimmed);
  const valid = Number.isInteger(value) && value >= 0 && value <= MAX_AMOUNT;
  return { value: valid ? value : null, valid };
}

export function NewOpportunitySheet({
  pipelineId,
  prefill,
  onClose,
  onCreated,
}: {
  // The pipeline preselected in the Pipeline select: the board being viewed. Without one, the first pipeline is used.
  pipelineId?: string;
  prefill?: NewOpportunityPrefill;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const pipelines = usePipelines();
  const create = useCreateOpportunity();
  const [name, setName] = useState('');
  const [person, setPerson] = useState<PickedRecord | null>(prefill?.person ?? null);
  const [organization, setOrganization] = useState<PickedRecord | null>(prefill?.organization ?? null);
  const [chosenPipelineId, setChosenPipelineId] = useState(pipelineId ?? '');
  const [stageId, setStageId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [problem, setProblem] = useState<string | null>(null);
  // Once the organization is chosen or cleared by hand (or arrived from an organization sheet), choosing a
  // person no longer replaces it.
  const organizationTouched = useRef(Boolean(prefill?.organization) && !prefill?.person);
  // True while the organization on the form came from a person (autofill), so changing or clearing the person
  // replaces or clears it. A hand choice or hand clear is never overwritten.
  const organizationAutofilled = useRef(Boolean(prefill?.organization) && Boolean(prefill?.person));

  const pipeline = pipelines.data?.find((item) => item.id === chosenPipelineId) ?? pipelines.data?.[0];
  const stages = useMemo(() => [...(pipeline?.stages ?? [])].sort((a, b) => a.seq - b.seq), [pipeline]);
  // The first stage is preselected until the user picks another.
  const selectedStage = stages.find((stage) => stage.id === stageId) ?? stages[0];
  const parsedAmount = parseAmount(amount);
  const trimmedName = name.trim();
  const ready = Boolean(trimmedName) && Boolean(selectedStage) && parsedAmount.valid && !create.isPending;
  // The server marks the linked person as a relationship once a deal sits past the first stage.
  const promotes = Boolean(person) && Boolean(selectedStage) && selectedStage!.seq > 1;

  // Stages belong to one pipeline, so choosing another pipeline resets the stage to that pipeline's first.
  const pickPipeline = (id: string) => {
    setChosenPipelineId(id);
    setStageId('');
  };

  const pickPerson = (record: PickedRecord | null) => {
    setPerson(record);
    if (organizationTouched.current) return;
    if (record?.organizationId) {
      organizationAutofilled.current = true;
      setOrganization({ id: record.organizationId, name: record.organizationName || 'Organization' });
    } else if (organizationAutofilled.current) {
      organizationAutofilled.current = false;
      setOrganization(null);
    }
  };

  const pickOrganization = (record: PickedRecord | null) => {
    organizationTouched.current = true;
    organizationAutofilled.current = false;
    setOrganization(record);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !selectedStage) return;
    setProblem(null);
    try {
      const opportunity = await create.mutateAsync({
        name: trimmedName,
        // The server derives the pipeline from the stage, and the stage options already follow the chosen pipeline.
        stageId: selectedStage.id,
        ...(person ? { personId: person.id } : {}),
        ...(organization ? { organizationId: organization.id } : {}),
        currency,
        ...(parsedAmount.value !== null ? { amountTarget: parsedAmount.value } : {}),
      });
      onCreated(opportunity.id);
    } catch (error) {
      setProblem(`${errorMessage(error)} The opportunity was not created. Adjust the fields and try again.`);
    }
  };

  return (
    <Sheet title="New opportunity" onClose={onClose}>
      {pipelines.isPending ? <Loading what="pipeline" /> : null}
      {pipelines.isError ? (
        <ErrorState what="the pipeline" error={pipelines.error} onRetry={() => void pipelines.refetch()} />
      ) : null}
      {pipelines.data && !pipeline ? (
        <p className="muted">No pipeline exists yet, so there is no stage to create an opportunity in.</p>
      ) : null}
      {pipeline ? (
        <form className="connector__form" onSubmit={(event) => void submit(event)} noValidate>
          <label className="field-label" htmlFor="new-opportunity-name">
            Name
          </label>
          <input
            id="new-opportunity-name"
            className="input"
            value={name}
            autoFocus
            required
            maxLength={200}
            aria-required="true"
            onChange={(event) => setName(event.target.value)}
          />
          <RecordPicker kind="person" label="Person" value={person} onChange={pickPerson} />
          <RecordPicker kind="organization" label="Organization" value={organization} onChange={pickOrganization} />
          <label className="field-label" htmlFor="new-opportunity-pipeline">
            Pipeline
          </label>
          <select
            id="new-opportunity-pipeline"
            className="input input--select"
            value={pipeline.id}
            onChange={(event) => pickPipeline(event.target.value)}
          >
            {pipelines.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <label className="field-label" htmlFor="new-opportunity-stage">
            Stage
          </label>
          <select
            id="new-opportunity-stage"
            className="input input--select"
            value={selectedStage?.id ?? ''}
            onChange={(event) => setStageId(event.target.value)}
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
          <div role="status">
            {promotes ? <p className="muted">Creating the deal at this stage marks the linked person as a relationship.</p> : null}
          </div>
          <label className="field-label" htmlFor="new-opportunity-amount">
            Amount
          </label>
          <div className="amount-row">
            <input
              id="new-opportunity-amount"
              className="input input--number num"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              placeholder="Optional"
              value={amount}
              aria-invalid={!parsedAmount.valid}
              aria-describedby={!parsedAmount.valid ? 'new-opportunity-amount-error' : undefined}
              onChange={(event) => setAmount(event.target.value)}
            />
            <label className="sr-only" htmlFor="new-opportunity-currency">
              Currency
            </label>
            <select
              id="new-opportunity-currency"
              className="input input--select"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          {!parsedAmount.valid ? (
            <p className="muted" role="alert" id="new-opportunity-amount-error">
              Enter the amount as a whole number, 0 or more.
            </p>
          ) : null}
          {problem ? (
            <p className="muted" role="alert">
              {problem}
            </p>
          ) : null}
          <div className="connector__row">
            <button type="submit" className="btn btn--primary" disabled={!ready}>
              {create.isPending ? 'Creating...' : 'Create opportunity'}
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
