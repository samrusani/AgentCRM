import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  useApifyActor,
  useApifyActorSearch,
  useApifyConnector,
  useImportBatch,
  useOrganization,
  usePerson,
  useStartApifyRun,
} from '../api/hooks';
import type { ApifyActorSummary, ImportCounts, ImportRow, Run } from '../api/types';
import { Chip, ErrorState, Loading, Sheet, errorMessage, type ChipTone } from '../components/common';
import { ImportCountsRow } from '../components/importReview';
import { SheetSection } from '../components/record';
import { formatAgo, humanize, personName } from '../lib/format';
import {
  MAX_ITEMS_CAP,
  MAX_ITEMS_DEFAULT,
  batchStatusLabel,
  checkActorInput,
  checkMaxItems,
  formatCount,
  mappedCompany,
  mappedEmail,
  mappedName,
  rowStatusLabel,
} from '../lib/imports';
import { recordLink } from '../lib/links';
import { useDebouncedValue } from '../lib/useDebouncedValue';

const MIN_QUERY_LENGTH = 2;

function actorLabel(actor: ApifyActorSummary): string {
  return actor.title ?? actor.name ?? actor.id;
}

function ActorFacts({ actor }: { actor: ApifyActorSummary }) {
  if (!actor.pricingHint && actor.totalRuns === null) return null;
  return (
    <span className="actor__facts">
      {actor.pricingHint ? <Chip tone="neutral">{actor.pricingHint}</Chip> : null}
      {actor.totalRuns !== null ? (
        <span className="muted num">{formatCount(actor.totalRuns)} total runs</span>
      ) : null}
    </span>
  );
}

function ActorOption({ actor, onSelect }: { actor: ApifyActorSummary; onSelect: () => void }) {
  return (
    <li>
      <button type="button" className="actor" data-actor-option onClick={onSelect}>
        <span className="actor__head">
          <span className="actor__title">{actorLabel(actor)}</span>
          {actor.username ? <span className="muted">{actor.username}</span> : null}
        </span>
        {actor.description ? <span className="actor__description">{actor.description}</span> : null}
        <ActorFacts actor={actor} />
      </button>
    </li>
  );
}

function ActorResults({
  query,
  q,
  onSelect,
}: {
  query: ReturnType<typeof useApifyActorSearch>;
  q: string;
  onSelect: (actor: ApifyActorSummary) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  if (q.length < MIN_QUERY_LENGTH) {
    return (
      <p className="muted">
        Search the Apify store by name or purpose, for example contact scraper. Type at least {MIN_QUERY_LENGTH}{' '}
        characters.
      </p>
    );
  }
  if (query.isPending || (query.isFetching && !query.data)) {
    return (
      <p className="muted" role="status">
        Searching the Apify store...
      </p>
    );
  }
  if (query.isError) {
    return (
      <div role="alert">
        <p className="inline-error">Search failed. {errorMessage(query.error)}</p>
        <button type="button" className="btn" onClick={() => void query.refetch()}>
          Retry search
        </button>
      </div>
    );
  }
  const actors = query.data ?? [];
  if (actors.length === 0) {
    return <p className="muted">No actors match this search. Try different words or a shorter phrase.</p>;
  }

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const nodes = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-actor-option]') ?? []);
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    if (event.key === 'ArrowDown') nodes[Math.min(nodes.length - 1, index + 1)]?.focus();
    else if (index <= 0) document.getElementById('apify-actor-search')?.focus();
    else nodes[index - 1]?.focus();
  };

  return (
    <>
      <p className="muted" role="status">
        <span className="num">{actors.length}</span> {actors.length === 1 ? 'actor' : 'actors'} found.
      </p>
      <ul className="actor-list" ref={listRef} onKeyDown={onKeyDown} aria-label="Actor search results">
        {actors.map((actor) => (
          <ActorOption key={actor.id} actor={actor} onSelect={() => onSelect(actor)} />
        ))}
      </ul>
    </>
  );
}

export function ImportSetupSheet({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (run: Run) => void;
}) {
  const { query: connectorsQuery, connector } = useApifyConnector();
  const connected = connector?.status === 'connected';
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 250);
  const [selected, setSelected] = useState<ApifyActorSummary | null>(null);
  const [inputText, setInputText] = useState('{}');
  const [inputTouched, setInputTouched] = useState(false);
  const [maxItemsText, setMaxItemsText] = useState(String(MAX_ITEMS_DEFAULT));

  const results = useApifyActorSearch(q, connected && !selected && q.length >= MIN_QUERY_LENGTH);
  const detail = useApifyActor(selected?.id ?? null);
  const start = useStartApifyRun();

  useEffect(() => {
    if (!connected) return;
    const frame = window.requestAnimationFrame(() => document.getElementById('apify-actor-search')?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [connected]);

  useEffect(() => {
    if (!selected || inputTouched || !detail.isSuccess) return;
    setInputText(detail.data.exampleInput ? JSON.stringify(detail.data.exampleInput, null, 2) : '{}');
  }, [selected, inputTouched, detail.isSuccess, detail.data]);

  const choose = (actor: ApifyActorSummary) => {
    setSelected(actor);
    setInputText('{}');
    setInputTouched(false);
    start.reset();
  };

  const inputCheck = useMemo(() => checkActorInput(inputText), [inputText]);
  const maxCheck = useMemo(() => checkMaxItems(maxItemsText), [maxItemsText]);
  const canStart = Boolean(selected) && inputCheck.ok && maxCheck.ok && !start.isPending;

  const submit = () => {
    if (!selected || !inputCheck.ok || !maxCheck.ok || start.isPending) return;
    start.mutate(
      {
        actorId: selected.id,
        input: inputCheck.value,
        maxItems: maxCheck.value,
        title: `Apify import: ${actorLabel(selected)}`,
      },
      { onSuccess: onStarted },
    );
  };

  return (
    <Sheet title="Import from Apify" subtitle="Run an actor. Its rows are staged for your review, and nothing enters the CRM until you approve." onClose={onClose}>
      {connectorsQuery.isPending ? <Loading what="connector" /> : null}
      {connectorsQuery.isError ? (
        <ErrorState what="the Apify connector" error={connectorsQuery.error} onRetry={() => void connectorsQuery.refetch()} />
      ) : null}

      {connectorsQuery.isSuccess && !connected ? (
        <div className="state">
          <p className="state__body">
            {connector?.status === 'error'
              ? `The Apify connection has an error: ${connector.statusMessage ?? 'the last check of the token failed.'} `
              : 'Apify is not connected. Add your Apify API token to import results from the Apify store. '}
            <Link className="link" to="/settings">
              Open Settings
            </Link>
          </p>
        </div>
      ) : null}

      {connected ? (
        <>
          <SheetSection title="Actor">
            {selected ? (
              <div className="actor-summary">
                <div className="actor__head">
                  <span className="actor__title">{actorLabel(selected)}</span>
                  {selected.username ? <span className="muted">{selected.username}</span> : null}
                </div>
                <p className="muted">{selected.id}</p>
                {selected.description ? <p>{selected.description}</p> : null}
                <ActorFacts actor={selected} />
                <div>
                  <button type="button" className="btn btn--quiet" onClick={() => setSelected(null)}>
                    Choose a different actor
                  </button>
                </div>
              </div>
            ) : (
              <>
                <label className="field-label" htmlFor="apify-actor-search">
                  Search the Apify store
                </label>
                <input
                  id="apify-actor-search"
                  className="input"
                  type="search"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Actor name or purpose"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      const first = document.querySelector<HTMLElement>('[data-actor-option]');
                      if (first) {
                        event.preventDefault();
                        first.focus();
                      }
                    }
                  }}
                />
                <div className="actor-results">
                  <ActorResults query={results} q={q} onSelect={choose} />
                </div>
              </>
            )}
          </SheetSection>

          <SheetSection title="Actor input">
            <label className="field-label" htmlFor="apify-input">
              Input as JSON
            </label>
            <textarea
              id="apify-input"
              className="input json-editor"
              rows={10}
              spellCheck={false}
              value={inputText}
              disabled={!selected}
              aria-invalid={!inputCheck.ok}
              aria-describedby="apify-input-note"
              onChange={(event) => {
                setInputText(event.target.value);
                setInputTouched(true);
              }}
            />
            {selected && !inputCheck.ok ? (
              <p className="inline-error" role="alert">
                {inputCheck.message}
              </p>
            ) : null}
            <p className="muted" id="apify-input-note">
              {!selected
                ? 'Choose an actor first. Its example input fills this editor when Apify provides one.'
                : detail.isPending
                  ? 'Loading the actor example input.'
                  : detail.isError
                    ? `The actor example input could not be loaded. ${errorMessage(detail.error)} You can still enter input yourself.`
                    : detail.data.exampleInput
                      ? inputTouched
                        ? 'You changed the example input from Apify.'
                        : 'Filled from the example input Apify provides for this actor.'
                      : 'Apify provides no example input for this actor. Start from an empty object and check the actor page for required fields.'}
            </p>
          </SheetSection>

          <SheetSection title="Limits and billing">
            <label className="field-label" htmlFor="apify-max-items">
              Max items
            </label>
            <input
              id="apify-max-items"
              className="input input--number num"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_ITEMS_CAP}
              step={1}
              value={maxItemsText}
              aria-invalid={!maxCheck.ok}
              aria-describedby="apify-max-note"
              onChange={(event) => setMaxItemsText(event.target.value)}
            />
            {!maxCheck.ok ? (
              <p className="inline-error" role="alert">
                {maxCheck.message}
              </p>
            ) : null}
            <p className="muted" id="apify-max-note">
              Default <span className="num">{MAX_ITEMS_DEFAULT}</span>, hard cap{' '}
              <span className="num">{formatCount(MAX_ITEMS_CAP)}</span> rows per run.
            </p>
            <p className="muted">
              Runs use your own Apify account and its billing. Apify bills the actor run even if you reject the
              results.
            </p>
          </SheetSection>

          {start.isError ? (
            <p className="inline-error" role="alert">
              Could not start the import run. {errorMessage(start.error)} Nothing was started.
            </p>
          ) : null}
          <div className="sheet-actions">
            <button type="button" className="btn btn--primary" onClick={submit} disabled={!canStart}>
              {start.isPending ? 'Starting...' : 'Start import run'}
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

const FILTERS: Array<{ value: string | null; label: string; count: (counts: ImportCounts) => number | null }> = [
  { value: null, label: 'All', count: (counts) => counts.fetched },
  { value: 'staged', label: 'Staged', count: (counts) => counts.staged },
  { value: 'duplicate', label: 'Duplicates', count: (counts) => counts.duplicates },
  { value: 'invalid', label: 'Invalid', count: (counts) => counts.invalid },
  { value: 'accepted', label: 'Accepted', count: (counts) => counts.accepted },
  { value: 'rejected', label: 'Rejected', count: (counts) => counts.rejected },
];

function batchTone(status: string): ChipTone {
  if (status === 'awaiting_review') return 'warn';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function MatchedRecord({ type, id }: { type: string; id: string }) {
  const person = usePerson(type === 'person' ? id : null);
  const organization = useOrganization(type === 'organization' ? id : null);
  const name =
    type === 'person' && person.data
      ? personName(person.data)
      : type === 'organization' && organization.data
        ? organization.data.name
        : null;
  const href = recordLink(type, id);
  const label = name ? `Matches ${name} (${humanize(type)})` : `Matches an existing ${humanize(type)}`;
  return href ? (
    <Link className="link" to={href}>
      {label}
    </Link>
  ) : (
    <span className="muted">{label}</span>
  );
}

function RowReason({ row }: { row: ImportRow }) {
  const hasMatch = Boolean(row.matchEntityType && row.matchEntityId);
  if (!row.reason && !hasMatch) return <span className="muted">None</span>;
  return (
    <>
      {row.reason ? <span>{row.reason}</span> : null}
      {hasMatch ? (
        <>
          {row.reason ? <br /> : null}
          <MatchedRecord type={row.matchEntityType as string} id={row.matchEntityId as string} />
        </>
      ) : null}
    </>
  );
}

export function ImportBatchSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const [filter, setFilter] = useState<string | null>(null);
  const query = useImportBatch(id, filter);
  const batch = query.data?.pages[0]?.batch ?? null;
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const refreshing = query.isPlaceholderData;

  return (
    <Sheet
      title="Import batch"
      subtitle={batch?.actorId ? `Actor ${batch.actorId}` : undefined}
      onClose={onClose}
      wide
    >
      {query.isPending ? <Loading what="import batch" /> : null}
      {query.isError ? <ErrorState what="this import batch" error={query.error} onRetry={() => void query.refetch()} /> : null}
      {batch ? (
        <>
          <SheetSection title="Status">
            <div className="batch-status">
              <Chip tone={batchTone(batch.status)}>{batchStatusLabel(batch.status)}</Chip>
              {batch.updatedAt ? <span className="muted">Updated {formatAgo(batch.updatedAt)}</span> : null}
            </div>
            <ImportCountsRow counts={batch.counts} accepted />
            {batch.apifyRunId || batch.datasetId ? (
              <dl className="fields">
                {batch.apifyRunId ? (
                  <div className="field">
                    <dt className="field__label">Apify run</dt>
                    <dd className="field__value">{batch.apifyRunId}</dd>
                  </div>
                ) : null}
                {batch.datasetId ? (
                  <div className="field">
                    <dt className="field__label">Dataset</dt>
                    <dd className="field__value">{batch.datasetId}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            {batch.runId ? (
              <p>
                <Link className="link" to={`/research?run=${encodeURIComponent(batch.runId)}`}>
                  Open the run
                </Link>
              </p>
            ) : null}
          </SheetSection>

          <SheetSection title="Rows">
            <div className="segmented" role="group" aria-label="Filter rows by status">
              {FILTERS.map((entry) => {
                const count = entry.count(batch.counts);
                const active = filter === entry.value;
                return (
                  <button
                    key={entry.label}
                    type="button"
                    className={active ? 'is-active' : undefined}
                    aria-pressed={active}
                    onClick={() => setFilter(entry.value)}
                  >
                    {entry.label}
                    {count !== null ? <span className="num"> {formatCount(count)}</span> : null}
                  </button>
                );
              })}
            </div>

            {rows.length === 0 && query.isFetching ? (
              <p className="muted batch-empty" role="status">
                Loading rows...
              </p>
            ) : rows.length === 0 ? (
              <p className="muted batch-empty">
                {filter
                  ? 'No rows have this status in this batch.'
                  : batch.status === 'staging'
                    ? 'Rows appear here as Apify results are staged. The run is still working.'
                    : 'This batch has no rows. The Apify run returned no usable items.'}
              </p>
            ) : (
              <div className="data-table__wrap" aria-busy={refreshing}>
                <table className={`data-table${refreshing ? ' is-refreshing' : ''}`}>
                  <caption className="sr-only">Rows in this import batch</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="is-numeric">
                        Row
                      </th>
                      <th scope="col">Name</th>
                      <th scope="col">Email</th>
                      <th scope="col">Company</th>
                      <th scope="col">Status</th>
                      <th scope="col">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const name = mappedName(row.mapped);
                      const email = mappedEmail(row.mapped);
                      const company = mappedCompany(row.mapped);
                      return (
                        <tr key={row.seq}>
                          <td className="is-numeric muted">{row.seq}</td>
                          <td className={name ? 'cell-name' : 'muted'}>{name ?? 'No name'}</td>
                          <td className={email ? undefined : 'muted'}>{email ?? 'No email'}</td>
                          <td className={company ? undefined : 'muted'}>{company ?? 'No company'}</td>
                          <td>
                            <Chip tone={row.status === 'invalid' ? 'danger' : 'neutral'}>{rowStatusLabel(row.status)}</Chip>
                          </td>
                          <td>
                            <RowReason row={row} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {rows.length > 0 ? (
              <div className="batch-more">
                <span className="muted num" role="status">
                  Showing {formatCount(rows.length)} {rows.length === 1 ? 'row' : 'rows'}
                </span>
                {query.hasNextPage ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void query.fetchNextPage()}
                    disabled={query.isFetchingNextPage}
                  >
                    {query.isFetchingNextPage ? 'Loading...' : 'Load more'}
                  </button>
                ) : (
                  <span className="muted">End of rows.</span>
                )}
              </div>
            ) : null}
            {query.isFetchNextPageError ? (
              <p className="inline-error" role="alert">
                Could not load more rows. {errorMessage(query.error)}
              </p>
            ) : null}
          </SheetSection>
        </>
      ) : null}
    </Sheet>
  );
}
