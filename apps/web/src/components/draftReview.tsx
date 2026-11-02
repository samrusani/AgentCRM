import type { DraftEntry, DraftReviewPayload, DraftRunIssues } from '../api/types';
import { isUnverifiedFact } from '../lib/drafts';
import { formatUsd, isLocalProvider } from '../lib/models';

function DraftRow({ draft, expanded }: { draft: DraftEntry; expanded: boolean }) {
  return (
    <li className="draft-row">
      <details open={expanded}>
        <summary className="draft-row__summary">
          <span className={draft.subject ? 'draft-sample__subject' : 'muted'}>{draft.subject ?? 'No subject'}</span>
          <span className="muted">To {draft.personName ?? 'unnamed person'}</span>
        </summary>
        <div className="draft-row__content">
          <p className="draft-row__body">{draft.body ?? 'No body.'}</p>
          <p className="draft-row__facts-title">Facts the model says it used:</p>
          {draft.factsUsed.length === 0 ? (
            <p className="muted">No record facts listed.</p>
          ) : (
            <ul className="draft-row__facts">
              {draft.factsUsed.map((fact, index) => (
                <li key={index} className={isUnverifiedFact(fact) ? 'draft-row__fact draft-row__fact--unverified' : 'draft-row__fact'}>
                  {fact.field}: {fact.value}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}

// Every draft is shown in full, because approving saves exactly this text. Rows start open in the run detail
// and closed in the compact panel and on Today, where space is short.
export function DraftReviewBody({ review, expanded = false }: { review: DraftReviewPayload; expanded?: boolean }) {
  const hasFull = review.drafts.length > 0;
  const legacy = !hasFull && review.count > 0;
  return (
    <div className="import-review">
      <dl className="counts counts--wrap" aria-label="Draft counts">
        <div>
          <dt>Drafts</dt>
          <dd>{review.count.toLocaleString()}</dd>
        </div>
        {isLocalProvider(review.provider) ? (
          <div>
            <dt>Cost</dt>
            <dd>Local, no cost</dd>
          </div>
        ) : review.estimatedUsd !== null ? (
          <div>
            <dt>Estimated cost so far</dt>
            <dd>
              {formatUsd(review.estimatedUsd)} <span className="muted counts__qualifier">estimate</span>
            </dd>
          </div>
        ) : null}
      </dl>
      {hasFull ? (
        <ul className="draft-rows" aria-label="Drafts to save">
          {review.drafts.map((draft, index) => (
            <DraftRow key={draft.personId ?? index} draft={draft} expanded={expanded} />
          ))}
        </ul>
      ) : review.sample.length > 0 ? (
        <ul className="draft-sample" aria-label="Sample drafts">
          {review.sample.map((entry, index) => (
            <li key={index} className="draft-sample__item">
              <span className={entry.subject ? 'draft-sample__subject' : 'muted'}>{entry.subject ?? 'No subject'}</span>
              <span className="muted">To {entry.personName ?? 'unnamed person'}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No drafts. Nothing was drafted.</p>
      )}
      {legacy ? (
        <p className="inline-error" role="alert">
          This approval was made before full drafts were included, so the text cannot be shown or saved. Reject it and
          draft again.
        </p>
      ) : null}
      <p className="muted">
        Saving puts each draft on its person as a draft that was not sent. Nothing is sent. Rejecting saves nothing.
        The facts listed are what the model says it used. The app only checks that each one appears in the record.
      </p>
      {review.count === 0 ? (
        <p className="muted">Nothing was drafted, so there is nothing to save. Reject to close this run.</p>
      ) : null}
    </div>
  );
}

function NoteList({ title, notes }: { title: string; notes: DraftRunIssues['failures'] }) {
  if (notes.length === 0) return null;
  return (
    <div className="draft-issues__group">
      <h4 className="draft-issues__title">
        {title} <span className="num muted">({notes.length})</span>
      </h4>
      <ul className="draft-issues__list">
        {notes.map((note, index) => (
          <li key={index} className="draft-issues__item">
            <span className="cell-name">{note.personName ?? 'Unnamed person'}</span>
            <span className="muted">{note.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// People a draft run did not draft for, and why. Without this the reasons stay inside the run.
export function DraftRunIssuesView({ issues }: { issues: DraftRunIssues }) {
  const { failures, skipped, stoppedEarly, notDrafted, budgetUsd, budgetDefaulted } = issues;
  if (failures.length === 0 && skipped.length === 0 && !stoppedEarly && !budgetDefaulted) return null;
  return (
    <section className="draft-issues" aria-label="People not drafted">
      {budgetDefaulted && budgetUsd !== null ? (
        <p className="muted">
          No budget was set for this run, so it used a default budget of {formatUsd(budgetUsd)} (estimate).
        </p>
      ) : null}
      {stoppedEarly ? (
        <p role="status">
          <span className="cell-name">Stopped early.</span> {stoppedEarly}
          {notDrafted !== null ? ` ${notDrafted} ${notDrafted === 1 ? 'person was' : 'people were'} not drafted.` : ''}
        </p>
      ) : null}
      <NoteList title="Failed" notes={failures} />
      <NoteList title="Skipped" notes={skipped} />
    </section>
  );
}
