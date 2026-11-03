import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFollowupRules, useMailProviderNamer, useStopFollowupRule } from '../api/hooks';
import type { FollowupRule } from '../api/types';
import { recordLink } from '../lib/links';
import {
  FOLLOWUP_STOP_CONFIRM,
  followupOutcomeLabel,
  followupStatusLine,
  isFollowupActive,
} from '../lib/mail';
import { EmptyState, ErrorState, Loading, errorMessage } from './common';

// Stopping is a human action that cannot be undone: nothing more is sent for this person. It asks once.
export function FollowupStopControl({ rule }: { rule: FollowupRule }) {
  const stop = useStopFollowupRule();
  const [confirming, setConfirming] = useState(false);
  const name = rule.personName ?? 'this person';

  return (
    <span className="lift">
      {confirming ? (
        <span className="followup-confirm" role="alert">
          {FOLLOWUP_STOP_CONFIRM}
          <button
            type="button"
            className="btn btn--danger"
            disabled={stop.isPending}
            onClick={() => stop.mutate(rule.id, { onSuccess: () => setConfirming(false) })}
          >
            {stop.isPending ? 'Stopping...' : 'Stop follow-ups'}
          </button>
          <button type="button" className="btn" disabled={stop.isPending} onClick={() => setConfirming(false)}>
            Keep them
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => setConfirming(true)}
          aria-label={`Stop follow-ups to ${name}`}
        >
          Stop
        </button>
      )}
      {stop.isError ? (
        <span className="inline-error" role="alert">
          {errorMessage(stop.error)} The follow-ups were not changed.
        </span>
      ) : null}
    </span>
  );
}

function ActiveRuleRow({ rule }: { rule: FollowupRule }) {
  const providerName = useMailProviderNamer();
  const link = recordLink('person', rule.personId);
  const name = rule.personName ?? 'Unnamed person';
  return (
    <li className="followup-row">
      <div className="followup-row__main">
        {link ? (
          <Link className="link cell-name" to={link}>
            {name}
          </Link>
        ) : (
          <span className="cell-name">{name}</span>
        )}
        <span>{followupStatusLine(rule)}</span>
        {rule.anchorSubject ? <span className="muted">After {rule.anchorSubject}</span> : null}
      </div>
      <div className="followup-row__side">
        {rule.provider ? <span className="muted">via {providerName(rule.provider)}</span> : null}
        <FollowupStopControl rule={rule} />
      </div>
    </li>
  );
}

function FinishedRuleRow({ rule }: { rule: FollowupRule }) {
  const link = recordLink('person', rule.personId);
  const name = rule.personName ?? 'Unnamed person';
  return (
    <li className="followup-row">
      <div className="followup-row__main">
        {link ? (
          <Link className="link cell-name" to={link}>
            {name}
          </Link>
        ) : (
          <span className="cell-name">{name}</span>
        )}
        {rule.anchorSubject ? <span className="muted">After {rule.anchorSubject}</span> : null}
      </div>
    </li>
  );
}

// Today section below the Outbox: active rules first, finished rules in a muted history grouped by how they ended.
export function Followups() {
  const rules = useFollowupRules();

  if (rules.isPending) return <Loading what="follow-ups" />;
  if (rules.isError) {
    return <ErrorState what="follow-ups" error={rules.error} onRetry={() => void rules.refetch()} />;
  }

  const active = rules.data.filter(isFollowupActive);
  const finished = rules.data.filter((rule) => !isFollowupActive(rule));
  const outcomes = new Map<string, FollowupRule[]>();
  for (const rule of finished) {
    const label = followupOutcomeLabel(rule);
    outcomes.set(label, [...(outcomes.get(label) ?? []), rule]);
  }

  return (
    <>
      {active.length === 0 ? (
        <EmptyState message="No follow-ups are active. Add one when you prepare a send." />
      ) : (
        <ul className="followup-list">
          {active.map((rule) => (
            <ActiveRuleRow key={rule.id} rule={rule} />
          ))}
        </ul>
      )}
      {finished.length > 0 ? (
        <details className="followup-history muted">
          <summary>
            History <span className="num">{finished.length}</span>
          </summary>
          {[...outcomes.entries()].map(([label, items]) => (
            <section key={label} className="followup-history__group" aria-label={label}>
              <h3 className="subsection__title">
                {label} <span className="num muted">{items.length}</span>
              </h3>
              <ul className="followup-list">
                {items.map((rule) => (
                  <FinishedRuleRow key={rule.id} rule={rule} />
                ))}
              </ul>
            </section>
          ))}
        </details>
      ) : null}
    </>
  );
}

// The person sheet: one line for every active rule of this person, each with its own stop control. With none active, one
// line for the newest finished rule, so the outcome of the last plan is still visible.
export function PersonFollowupLine({ personId }: { personId: string }) {
  const rules = useFollowupRules({ personId });
  const all = rules.data ?? [];
  const active = all.filter(isFollowupActive);
  const shown = active.length > 0 ? active : all.slice(0, 1);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((rule) => (
        <p key={rule.id} className="followup-line">
          <span className="muted">Follow-ups</span>{' '}
          <span>{isFollowupActive(rule) ? followupStatusLine(rule) : followupOutcomeLabel(rule)}</span>
          {isFollowupActive(rule) ? <FollowupStopControl rule={rule} /> : null}
        </p>
      ))}
    </>
  );
}
