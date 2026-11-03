import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useControlSendIntent, useMailProvider, useMailProviderNamer, useMailSummary, useSendIntents } from '../api/hooks';
import type { MailSummary, SendIntent } from '../api/types';
import { formatAgo } from '../lib/format';
import { recordLink } from '../lib/links';
import {
  ACKNOWLEDGEABLE_STATUSES,
  CANCELLABLE_STATUSES,
  OUTBOX_GROUPS,
  reasonSentence,
} from '../lib/mail';
import { EmptyState, ErrorState, Loading, errorMessage } from './common';

const GROUP_ROWS_SHOWN = 10;

function OutboxRow({ intent }: { intent: SendIntent }) {
  const providerName = useMailProviderNamer();
  const control = useControlSendIntent();
  const [confirming, setConfirming] = useState(false);
  const link = recordLink('person', intent.personId);
  const name = intent.personName ?? intent.toEmail;
  const canCancel = CANCELLABLE_STATUSES.includes(intent.status);
  const canAcknowledge = ACKNOWLEDGEABLE_STATUSES.includes(intent.status);
  const showReason = ['blocked', 'failed', 'unknown'].includes(intent.status);
  const when = intent.submittedAt ?? intent.updatedAt;

  return (
    <li className="outbox-row">
      <div className="outbox-row__main">
        <span className="outbox-row__who">
          {link ? (
            <Link className="link cell-name" to={link}>
              {name}
            </Link>
          ) : (
            <span className="cell-name">{name}</span>
          )}
          {intent.personName ? <span className="muted"> {intent.toEmail}</span> : null}
        </span>
        <span className="outbox-row__subject">{intent.subject || 'No subject'}</span>
        {showReason ? (
          <span className="outbox-row__reason muted">
            {intent.error
              ? reasonSentence(intent.error)
              : intent.status === 'unknown'
                ? 'The provider did not confirm the outcome.'
                : 'No reason was recorded.'}
          </span>
        ) : null}
      </div>
      <div className="outbox-row__side">
        {intent.provider || intent.address ? (
          <span className="muted">
            via {intent.provider ? providerName(intent.provider) : null}
            {intent.provider && intent.address ? ', ' : null}
            {intent.address}
          </span>
        ) : null}
        {when ? <span className="muted num">{formatAgo(when)}</span> : null}
        {canCancel ? (
          <button
            type="button"
            className="btn btn--quiet"
            disabled={control.isPending}
            onClick={() => control.mutate({ id: intent.id, action: 'cancel' })}
            aria-label={`Cancel send to ${name}: ${intent.subject}`}
          >
            {control.isPending ? 'Cancelling...' : 'Cancel send'}
          </button>
        ) : null}
        {canAcknowledge && !confirming ? (
          <button
            type="button"
            className="btn"
            onClick={() => setConfirming(true)}
            aria-label={`Acknowledge ${intent.status === 'unknown' ? 'unknown outcome' : 'blocked send'} for ${name}`}
          >
            Acknowledge
          </button>
        ) : null}
      </div>
      {canAcknowledge && confirming ? (
        <div className="outbox-row__confirm" role="alert">
          {intent.status === 'unknown'
            ? 'This message may or may not have been sent. Acknowledging marks it cancelled here. It does not resend and it does not undo a send. The draft stays out of new sends, so check the sent mail at the provider first.'
            : 'Acknowledging marks this blocked message cancelled. It will not be sent. Prepare it again to send it later.'}
          <button
            type="button"
            className="btn btn--primary"
            disabled={control.isPending}
            onClick={() => control.mutate({ id: intent.id, action: 'acknowledge' }, { onSuccess: () => setConfirming(false) })}
          >
            {control.isPending ? 'Acknowledging...' : 'Acknowledge'}
          </button>
          <button type="button" className="btn" disabled={control.isPending} onClick={() => setConfirming(false)}>
            Keep it listed
          </button>
        </div>
      ) : null}
      {control.isError ? (
        <p className="inline-error outbox-row__error" role="alert">
          {errorMessage(control.error)} The message state did not change.
        </p>
      ) : null}
    </li>
  );
}

function OutboxGroup({ label, note, items }: { label: string; note?: string; items: SendIntent[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, GROUP_ROWS_SHOWN);
  return (
    <section className="outbox-group" aria-label={label}>
      <h3 className="subsection__title">
        {label} <span className="num muted">{items.length}</span>
      </h3>
      {note ? <p className="muted">{note}</p> : null}
      <ul className="outbox-list">
        {shown.map((intent) => (
          <OutboxRow key={intent.id} intent={intent} />
        ))}
      </ul>
      {items.length > shown.length ? (
        <button type="button" className="btn btn--quiet" onClick={() => setShowAll(true)}>
          Show all <span className="num">{items.length}</span>
        </button>
      ) : null}
    </section>
  );
}

// Names the provider and address new sends go out through. Open intents name the provider that staged them.
function SendingLine() {
  const provider = useMailProvider();
  const providerName = useMailProviderNamer();
  if (!provider.isSuccess) return null;
  const active = provider.data;
  return (
    <p className="muted">
      {active ? (
        <>
          Sending with {providerName(active.kind)}
          {active.address ? (
            <>
              {' '}
              from <span className="cell-name">{active.address}</span>
            </>
          ) : (
            ', which has no sending address yet'
          )}
          . Messages already queued stay with the provider that staged them.
        </>
      ) : (
        'No sending connector is in use. Connect one in Settings.'
      )}
    </p>
  );
}

function CapLine({ summary }: { summary: MailSummary | undefined }) {
  if (!summary) return null;
  return (
    <p className="muted">
      {summary.remainingDailyCap !== null ? (
        <>
          <span className="num">{summary.remainingDailyCap.toLocaleString()}</span> of{' '}
          <span className="num">{summary.dailyCap.toLocaleString()}</span> sends remain today.{' '}
        </>
      ) : null}
      {summary.lastSyncAt ? `Last synced ${formatAgo(summary.lastSyncAt)}.` : 'Not synced yet.'}
    </p>
  );
}

export function Outbox() {
  const intents = useSendIntents();
  const summary = useMailSummary();

  if (intents.isPending) return <Loading what="the outbox" />;
  if (intents.isError) {
    return <ErrorState what="the outbox" error={intents.error} onRetry={() => void intents.refetch()} />;
  }

  const items = intents.data;
  const groups = OUTBOX_GROUPS.map((group) => ({
    ...group,
    items: items.filter((intent) => group.statuses.includes(intent.status)),
  })).filter((group) => group.items.length > 0);
  const cancelled = items.filter((intent) => intent.status === 'cancelled').length;
  const known = new Set(OUTBOX_GROUPS.flatMap((group) => group.statuses).concat('cancelled'));
  const other = items.filter((intent) => !known.has(intent.status));

  return (
    <>
      {groups.length === 0 && other.length === 0 ? (
        <EmptyState message="Nothing is queued or sent. Messages you prepare from saved drafts appear here with their state." />
      ) : (
        <div className="outbox">
          {groups.map((group) => (
            <OutboxGroup key={group.key} label={group.label} note={group.note} items={group.items} />
          ))}
          {other.length > 0 ? <OutboxGroup label="Other states" items={other} /> : null}
        </div>
      )}
      {cancelled > 0 ? (
        <p className="muted">
          <span className="num">{cancelled.toLocaleString()}</span> cancelled {cancelled === 1 ? 'message is' : 'messages are'} not
          listed.
        </p>
      ) : null}
      {summary.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(summary.error)} The daily cap and sync time did not load.
        </p>
      ) : (
        <CapLine summary={summary.data} />
      )}
      <SendingLine />
    </>
  );
}
