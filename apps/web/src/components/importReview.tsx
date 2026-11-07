import { Link } from 'react-router-dom';
import type { Approval, ImportCounts, ImportReviewPayload } from '../api/types';
import { formatAgo } from '../lib/format';
import { formatCount, profileLabel } from '../lib/imports';

export function ImportCountsRow({ counts, accepted }: { counts: ImportCounts; accepted?: boolean }) {
  const items: Array<{ label: string; value: number }> = [
    { label: 'Fetched', value: counts.fetched },
    { label: 'Staged', value: counts.staged },
    { label: 'Duplicates', value: counts.duplicates },
    { label: 'Invalid', value: counts.invalid },
  ];
  if (accepted && counts.accepted !== null) items.push({ label: 'Accepted', value: counts.accepted });
  if (accepted && counts.rejected !== null) items.push({ label: 'Rejected', value: counts.rejected });
  return (
    <dl className="counts counts--wrap" aria-label="Import counts">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{formatCount(item.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

// The Name cell of a staged row. An organization shows its company name with an "Organization" marker, so a
// fund named in a post is never shown as a person.
export function RowNameCell({
  kind,
  name,
  company,
}: {
  kind: 'person' | 'organization';
  name: string | null;
  company: string | null;
}) {
  if (kind === 'organization') {
    const label = company ?? name;
    return (
      <td className={label ? 'cell-name' : 'muted'}>
        {label ?? 'No name'} <span className="muted row-kind">Organization</span>
      </td>
    );
  }
  return <td className={name ? 'cell-name' : 'muted'}>{name ?? 'No name'}</td>;
}

export function batchHref(batchId: string, runId: string | null): string {
  const params = new URLSearchParams();
  if (runId) params.set('run', runId);
  params.set('batch', batchId);
  return `/research?${params.toString()}`;
}

export function ImportReviewBody({ approval, review }: { approval: Approval; review: ImportReviewPayload }) {
  const { counts, sample } = review;
  const hidden = Math.max(0, counts.staged - sample.length);
  // Lead capture samples carry a title and a profile. Other imports do not, so their table keeps three columns.
  const showPeople = sample.some((row) => row.title !== null || row.linkedinUrl !== null);
  return (
    <div className="import-review">
      <ImportCountsRow counts={counts} />
      {review.pasted ? (
        <p className="muted import-review__source">
          From pasted post text
          {review.postUrl ? (
            <>
              {' '}
              <span className="import-review__actor">{review.postUrl}</span>
            </>
          ) : null}
        </p>
      ) : review.postUrl ? (
        <p className="muted import-review__source">
          From a LinkedIn post <span className="import-review__actor">{review.postUrl}</span>
        </p>
      ) : null}
      {review.actorId && !review.postUrl ? (
        <p className="muted import-review__source">
          Actor <span className="import-review__actor">{review.actorId}</span>
        </p>
      ) : null}
      {review.mailbox ? (
        <p className="muted import-review__source">From mail already synced to this computer</p>
      ) : null}
      {sample.length > 0 && review.mailbox ? (
        <div className="mini-table__wrap">
          <table className="mini-table">
            <caption className="sr-only">Sample of staged correspondents</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col" className="is-numeric">
                  In
                </th>
                <th scope="col" className="is-numeric">
                  Out
                </th>
                <th scope="col">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {sample.map((row, index) => (
                <tr key={index}>
                  <td className={row.name ? 'cell-name' : 'muted'}>{row.name ?? 'No name'}</td>
                  <td className={row.email ? '' : 'muted'}>{row.email ?? 'No email'}</td>
                  <td className="is-numeric num">{formatCount(row.inbound ?? 0)}</td>
                  <td className="is-numeric num">{formatCount(row.outbound ?? 0)}</td>
                  <td className={row.lastSeenAt ? '' : 'muted'}>{row.lastSeenAt ? formatAgo(row.lastSeenAt) : 'Unknown'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : sample.length > 0 ? (
        <div className="mini-table__wrap">
          <table className="mini-table">
            <caption className="sr-only">Sample of staged rows</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Company</th>
                {showPeople ? <th scope="col">Title</th> : null}
                {showPeople ? <th scope="col">Profile</th> : null}
              </tr>
            </thead>
            <tbody>
              {sample.map((row, index) => (
                <tr key={index}>
                  <RowNameCell kind={row.kind} name={row.name} company={row.company} />
                  <td className={row.email && row.kind === 'person' ? '' : 'muted'}>
                    {row.kind === 'person' ? (row.email ?? 'No email') : 'No email'}
                  </td>
                  <td className={row.company ? '' : 'muted'}>{row.company ?? 'No company'}</td>
                  {showPeople ? (
                    <td className={row.title && row.kind === 'person' ? '' : 'muted'}>
                      {row.kind === 'person' ? (row.title ?? 'No title') : 'No title'}
                    </td>
                  ) : null}
                  {showPeople ? (
                    <td className={row.linkedinUrl ? '' : 'muted'} title={row.linkedinUrl ?? undefined}>
                      {row.linkedinUrl ? profileLabel(row.linkedinUrl) : 'No profile'}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No sample rows. Nothing was staged.</p>
      )}
      {sample.length > 0 && hidden > 0 ? (
        <p className="muted">
          Showing <span className="num">{sample.length}</span> of <span className="num">{formatCount(counts.staged)}</span>{' '}
          staged rows.
        </p>
      ) : null}
      <p className="muted">
        Duplicates and invalid rows are not imported. Each one lists its reason in the batch.
        {review.batchId ? (
          <>
            {' '}
            <Link className="link" to={batchHref(review.batchId, approval.runId)}>
              View batch
            </Link>
          </>
        ) : null}
      </p>
      {counts.staged === 0 ? (
        <p className="muted">Nothing is staged, so there is nothing to approve. Reject to close this import.</p>
      ) : null}
    </div>
  );
}
