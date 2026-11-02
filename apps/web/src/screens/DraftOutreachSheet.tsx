import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useModelConnector, useModelProvider, useStartDraftOutreach } from '../api/hooks';
import type { DraftOutreachInput, Run } from '../api/types';
import { ErrorState, Loading, Sheet, errorMessage } from '../components/common';
import { SheetSection } from '../components/record';
import { MAX_PEOPLE_CAP, MAX_PEOPLE_DEFAULT, checkBudget, checkMaxPeople } from '../lib/drafts';
import {
  DRAFT_INPUT_TOKENS,
  DRAFT_OUTPUT_TOKENS,
  estimateDraftCost,
  findProvider,
  formatUsd,
  isLocalProvider,
  pricedModel,
  providerAttention,
  providerName,
} from '../lib/models';

type Audience = 'eligible' | 'tag';

export function DraftOutreachSheet({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (run: Run) => void;
}) {
  const query = useModelProvider();
  const active = query.data ?? null;
  // Only a ready provider lets drafting start: connected, no rejected key, and for Ollama a model chosen.
  const connected = active !== null && active.ready;
  const attention = active && !active.ready ? providerAttention(active) : null;
  const local = isLocalProvider(active?.kind);
  const { connector: ollama } = useModelConnector('ollama');
  const providerLabel = providerName(active?.kind);
  const destination =
    local && ollama?.baseUrl ? `the Ollama server at ${ollama.baseUrl}` : local ? 'the local Ollama server' : providerLabel;
  const start = useStartDraftOutreach();
  const [audience, setAudience] = useState<Audience>('eligible');
  const [tag, setTag] = useState('');
  const [instructions, setInstructions] = useState('');
  const [maxPeopleText, setMaxPeopleText] = useState(String(MAX_PEOPLE_DEFAULT));
  const [budgetText, setBudgetText] = useState('');

  const maxCheck = useMemo(() => checkMaxPeople(maxPeopleText), [maxPeopleText]);
  const budgetCheck = useMemo(() => checkBudget(budgetText), [budgetText]);
  const tagValue = tag.trim();
  const tagMissing = audience === 'tag' && tagValue === '';

  const priced = local ? null : pricedModel(active?.kind, active?.model);
  const range = maxCheck.ok && priced ? estimateDraftCost(maxCheck.value, priced.model) : null;
  const peakNote = findProvider(active?.kind)?.priceNote ?? null;
  const budget = budgetCheck.ok ? budgetCheck.value : null;

  const canStart = connected && maxCheck.ok && budgetCheck.ok && !tagMissing && !start.isPending;

  const submit = () => {
    if (!canStart || !maxCheck.ok || !budgetCheck.ok) return;
    const input: DraftOutreachInput = {
      maxPeople: maxCheck.value,
      title: `Draft outreach, up to ${maxCheck.value} ${maxCheck.value === 1 ? 'person' : 'people'}`,
    };
    if (audience === 'tag') input.tag = tagValue;
    if (instructions.trim()) input.instructions = instructions.trim();
    if (budgetCheck.value !== null) input.budgetUsd = budgetCheck.value;
    start.mutate(input, { onSuccess: onStarted });
  };

  return (
    <Sheet
      title="Draft outreach"
      subtitle="The agent writes one draft per person. Drafts are created for review and nothing is sent."
      onClose={onClose}
    >
      {query.isPending ? <Loading what="the model provider" /> : null}
      {query.isError ? (
        <ErrorState what="the model provider" error={query.error} onRetry={() => void query.refetch()} />
      ) : null}

      {query.isSuccess && attention ? (
        <div className="state">
          <p className="state__body">
            {attention} No drafts can be written until it is fixed.{' '}
            <Link className="link" to="/settings">
              Open Settings
            </Link>
          </p>
        </div>
      ) : null}

      {query.isSuccess && !active ? (
        <div className="state">
          <p className="state__body">
            No model provider is connected, so no drafts can be written. Connect one in Settings and choose it, then
            draft outreach.{' '}
            <Link className="link" to="/settings">
              Open Settings
            </Link>
          </p>
        </div>
      ) : null}

      {connected ? (
        <>
          <SheetSection title="Audience">
            <div className="radio-stack" role="radiogroup" aria-label="Audience">
              <label className="radio">
                <input
                  type="radio"
                  name="draft-audience"
                  checked={audience === 'eligible'}
                  onChange={() => setAudience('eligible')}
                />
                <span>Everyone eligible</span>
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="draft-audience"
                  checked={audience === 'tag'}
                  onChange={() => setAudience('tag')}
                />
                <span>People with a tag</span>
              </label>
              {audience === 'tag' ? (
                <div>
                  <label className="sr-only" htmlFor="draft-tag">
                    Tag
                  </label>
                  <input
                    id="draft-tag"
                    className="input"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="A tag such as seed"
                    value={tag}
                    aria-invalid={tagMissing}
                    onChange={(event) => setTag(event.target.value)}
                  />
                  {tagMissing ? (
                    <p className="inline-error" role="alert">
                      Enter the tag to draft for, or choose everyone eligible.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <p className="muted">
              Eligible people have an email, are not excluded by qualification, and are not tagged do-not-contact.
              People who are skipped are counted with a reason in the run.
            </p>
          </SheetSection>

          <SheetSection title="Instructions">
            <label className="field-label" htmlFor="draft-instructions">
              What the drafts should say (optional)
            </label>
            <textarea
              id="draft-instructions"
              className="input"
              rows={6}
              value={instructions}
              placeholder="Your voice, the ask, and anything to avoid"
              onChange={(event) => setInstructions(event.target.value)}
            />
            <p className="muted">
              Plain text. Each draft lists the record facts the model says it used, and record content is treated as
              data, not as instructions.
            </p>
            <p className="muted">
              Drafting sends record contents (people, organizations, claims, notes) to {destination}.
            </p>
          </SheetSection>

          <SheetSection title="Limits and cost">
            <label className="field-label" htmlFor="draft-max-people">
              Max people
            </label>
            <input
              id="draft-max-people"
              className="input input--number num"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_PEOPLE_CAP}
              step={1}
              value={maxPeopleText}
              aria-invalid={!maxCheck.ok}
              aria-describedby="draft-max-note"
              onChange={(event) => setMaxPeopleText(event.target.value)}
            />
            {!maxCheck.ok ? (
              <p className="inline-error" role="alert">
                {maxCheck.message}
              </p>
            ) : null}
            <p className="muted" id="draft-max-note">
              Default <span className="num">{MAX_PEOPLE_DEFAULT}</span>, hard cap <span className="num">{MAX_PEOPLE_CAP}</span>{' '}
              people per run. The run drafts for fewer people when fewer are eligible.
            </p>

            <label className="field-label" htmlFor="draft-budget">
              Budget in US dollars (optional)
            </label>
            <input
              id="draft-budget"
              className="input input--money num"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="No budget"
              value={budgetText}
              aria-invalid={!budgetCheck.ok}
              aria-describedby="draft-budget-note"
              onChange={(event) => setBudgetText(event.target.value)}
            />
            {!budgetCheck.ok ? (
              <p className="inline-error" role="alert">
                {budgetCheck.message}
              </p>
            ) : null}
            <p className="muted" id="draft-budget-note">
              {budget !== null
                ? `The budget of ${formatUsd(budget)} is checked between drafts. The first draft always runs, and a draft that costs more than average can push the total past it. The run stops when the next draft would likely pass the budget and finishes partial.`
                : 'With no budget, only the max people limit bounds the cost.'}
              {budget !== null && range && budget < range.low
                ? ' This budget is below the low end of the estimate, so the run will probably stop early.'
                : ''}
            </p>

            <div className="estimate-line" aria-live="polite">
              {local ? (
                <>
                  <span>Estimated cost: local, no cost</span>
                  <span className="muted">
                    Drafts run on {destination}, so there is no per token charge. Time depends on your computer and the
                    model.
                  </span>
                </>
              ) : (
                <>
                  {range ? (
                    <span>
                      Estimated cost: <span className="num">{formatUsd(range.low)}</span> to{' '}
                      <span className="num">{formatUsd(range.high)}</span> (estimate)
                    </span>
                  ) : maxCheck.ok ? (
                    <span>Estimated cost: not available, this build has no list prices for {providerLabel}.</span>
                  ) : (
                    <span>Estimated cost: enter a valid max people to see it.</span>
                  )}
                  {priced ? (
                    <span className="muted">
                      Assumes about <span className="num">{DRAFT_INPUT_TOKENS.toLocaleString()}</span> input and{' '}
                      <span className="num">{DRAFT_OUTPUT_TOKENS}</span> output tokens per draft at{' '}
                      {priced.exact
                        ? `${providerLabel} ${priced.model.name}`
                        : `${providerLabel} ${priced.model.name} (the chosen model is unknown here, so the default model is priced)`}{' '}
                      list prices,
                      <span className="num"> {priced.model.inputPerMillion.toFixed(2)}</span> in /{' '}
                      <span className="num">{priced.model.outputPerMillion.toFixed(2)}</span> out per million tokens.
                      {peakNote ? ` ${peakNote}` : ''} The range is wide because prompts vary with each record.
                      Thinking tokens bill as output, so real cost can pass the high end. {providerLabel} bills your own
                      account.
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </SheetSection>

          {start.isError ? (
            <p className="inline-error" role="alert">
              Could not start the draft run. {errorMessage(start.error)} Nothing was started.
            </p>
          ) : null}
          <div className="sheet-actions">
            <button type="button" className="btn btn--primary" onClick={submit} disabled={!canStart}>
              {start.isPending
                ? 'Starting...'
                : maxCheck.ok
                  ? `Draft ${maxCheck.value} ${maxCheck.value === 1 ? 'message' : 'messages'}`
                  : 'Draft messages'}
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
