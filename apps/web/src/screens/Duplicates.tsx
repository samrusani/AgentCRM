import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDismissDuplicate, useDuplicates, useMergePeople } from '../api/hooks';
import type { DuplicatePair, DuplicateSummary } from '../api/types';
import { Chip, EmptyState, ErrorState, Loading, PageHeader, errorMessage } from '../components/common';
import { formatDate, humanize } from '../lib/format';
import { profilePath } from '../lib/links';

type Side = 'left' | 'right';

export const DUPLICATES_EMPTY =
  'No duplicate candidates. New captures and imports are checked against existing records when they are staged.';
export const DUPLICATES_CAPPED = 'Showing the first 200 pairs. Merge or dismiss some to see more.';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// The consequences of keeping one side, built from the pair itself: the other record's deals, tasks, and activities move
// to the kept record, and the empty fields the kept record would fill come from the server's count.
export function mergeConsequence(other: DuplicateSummary, fills: number): string {
  return `Moves ${plural(other.deals, 'deal', 'deals')}, ${plural(other.tasks, 'task', 'tasks')}, and ${plural(other.activities, 'activity', 'activities')}, fills ${plural(fills, 'empty field', 'empty fields')}, and deletes the other record. This cannot be undone.`;
}

const pairKey = (pair: DuplicatePair) => pair.personIds.join('|');

export function Duplicates() {
  const query = useDuplicates();
  const dismiss = useDismissDuplicate();
  const merge = useMergePeople();
  const [confirming, setConfirming] = useState<{ key: string; keep: Side } | null>(null);
  const [problem, setProblem] = useState<{ key: string; message: string } | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());

  // The confirm names a pair as it was loaded. When the list reloads underneath, it starts over.
  useEffect(() => {
    setConfirming(null);
  }, [query.dataUpdatedAt]);

  const pairs = (query.data?.pairs ?? []).filter((pair) => !gone.has(pairKey(pair)));

  const doDismiss = (pair: DuplicatePair) => {
    const key = pairKey(pair);
    setProblem(null);
    dismiss.mutate(pair.personIds, {
      onSuccess: () => setGone((current) => new Set(current).add(key)),
      onError: (error) => setProblem({ key, message: errorMessage(error) }),
    });
  };

  const doMerge = (pair: DuplicatePair, keep: Side) => {
    const key = pairKey(pair);
    const survivor = keep === 'left' ? pair.left : pair.right;
    const other = keep === 'left' ? pair.right : pair.left;
    setProblem(null);
    merge.mutate(
      { survivorId: survivor.id, otherId: other.id, expectedVersion: survivor.version, otherExpectedVersion: other.version },
      {
        onSuccess: () => {
          setConfirming(null);
          setGone((current) => new Set(current).add(key));
        },
        onError: (error) => setProblem({ key, message: errorMessage(error) }),
      },
    );
  };

  return (
    <div className="screen">
      <PageHeader title="Duplicates" description="People who look like the same person. Keep one record or say they are different." />
      {query.isPending ? (
        <Loading what="duplicates" />
      ) : query.isError ? (
        <ErrorState what="duplicates" error={query.error} onRetry={() => void query.refetch()} />
      ) : pairs.length === 0 ? (
        <EmptyState message={DUPLICATES_EMPTY} />
      ) : (
        <>
          {query.data?.capped ? <p className="muted">{DUPLICATES_CAPPED}</p> : null}
          <ul className="duplicate-list" aria-label="Duplicate candidates">
            {pairs.map((pair) => {
              const key = pairKey(pair);
              const active = confirming?.key === key ? confirming.keep : null;
              const busy = merge.isPending || dismiss.isPending;
              return (
                <li key={key} className="duplicate-card">
                  <p className="duplicate-card__reason">{pair.reasonText}</p>
                  <div className="duplicate-card__sides">
                    <PersonSide label="Left" person={pair.left} />
                    <PersonSide label="Right" person={pair.right} />
                  </div>
                  {active ? (
                    <div className="duplicate-card__confirm" role="group" aria-label="Confirm merge">
                      <p>
                        Keep {(active === 'left' ? pair.left : pair.right).name}.{' '}
                        {mergeConsequence(
                          active === 'left' ? pair.right : pair.left,
                          active === 'left' ? pair.fillsIfKeepLeft : pair.fillsIfKeepRight,
                        )}
                      </p>
                      <div className="duplicate-card__actions">
                        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => doMerge(pair, active)}>
                          Merge records
                        </button>
                        <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="duplicate-card__actions">
                      <button type="button" className="btn" disabled={busy} onClick={() => setConfirming({ key, keep: 'left' })}>
                        Keep left
                      </button>
                      <button type="button" className="btn" disabled={busy} onClick={() => setConfirming({ key, keep: 'right' })}>
                        Keep right
                      </button>
                      <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => doDismiss(pair)}>
                        Not duplicates
                      </button>
                    </div>
                  )}
                  {problem?.key === key ? (
                    <p className="inline-error" role="alert">
                      {problem.message}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function PersonSide({ label, person }: { label: string; person: DuplicateSummary }) {
  const screen = person.lifecycle === 'lead' ? 'leads' : 'relationships';
  return (
    <section className="duplicate-side" aria-label={`${label} record`}>
      <h2 className="duplicate-side__name">
        <Link to={`/${screen}?tab=people&person=${encodeURIComponent(person.id)}`}>{person.name}</Link>{' '}
        <Chip tone={person.lifecycle === 'relationship' ? 'accent' : 'neutral'}>{humanize(person.lifecycle)}</Chip>
      </h2>
      <dl className="duplicate-side__facts">
        <dt>Email</dt>
        <dd>{person.email ?? 'None'}</dd>
        <dt>Organization</dt>
        <dd>{person.organizationName ?? 'None'}</dd>
        <dt>Profile</dt>
        <dd>{person.linkedinUrl ? profilePath(person.linkedinUrl) : 'None'}</dd>
        <dt>Created</dt>
        <dd className="num">{formatDate(person.createdAt)}</dd>
      </dl>
    </section>
  );
}
