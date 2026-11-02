import { Link } from 'react-router-dom';
import { useMailSummary } from '../api/hooks';
import type { SendExcluded, SendReviewMessage, SendReviewPayload } from '../api/types';
import { DAILY_SEND_CAP, isMessageComplete, messageCountLabel, reasonSentence } from '../lib/mail';

export const SEND_REVIEW_FIXED_LINE = 'Approving sends these exact messages. Nothing can be edited after approval.';

export function ExcludedList({ excluded, heading }: { excluded: SendExcluded[]; heading?: string }) {
  if (excluded.length === 0) return null;
  return (
    <section className="send-excluded" aria-label="People left out of this send">
      <h4 className="send-excluded__title">
        {heading ?? 'Left out'} <span className="num muted">({excluded.length})</span>
      </h4>
      <ul className="send-excluded__list">
        {excluded.map((entry, index) => (
          <li key={index} className="send-excluded__item">
            <span className="cell-name">{entry.personName ?? 'Unnamed person'}</span>
            {entry.toEmail ? <span className="muted"> {entry.toEmail}</span> : null}
            <span className="send-excluded__reason muted">{reasonSentence(entry.reason)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MessageBlock({ message, position, total }: { message: SendReviewMessage; position: number; total: number }) {
  return (
    <li className="send-message">
      <p className="send-message__position muted num">
        Message {position} of {total}
      </p>
      <dl className="send-message__fields">
        <div>
          <dt>To</dt>
          <dd>
            {message.personName ? <span className="cell-name">{message.personName} </span> : null}
            <span>{message.to ?? 'No address'}</span>
          </dd>
        </div>
        <div>
          <dt>From</dt>
          <dd>{message.inboxEmail ?? 'No sending inbox'}</dd>
        </div>
        <div>
          <dt>Subject</dt>
          <dd className="cell-name">{message.subject ?? 'No subject'}</dd>
        </div>
      </dl>
      <p className="send-message__body">{message.body ?? 'No body.'}</p>
    </li>
  );
}

// The strictest card in the product. Every message is shown in full, never collapsed, because approving sends
// exactly this text. The caller decides whether the surface may offer the buttons.
export function SendReviewBody({ review }: { review: SendReviewPayload }) {
  const summary = useMailSummary();
  const remaining = review.remainingDailyCap ?? summary.data?.remainingDailyCap ?? null;
  const cap = summary.data?.dailyCap ?? DAILY_SEND_CAP;
  const incomplete = review.messages.some((message) => !isMessageComplete(message));

  return (
    <div className="send-review">
      <dl className="counts counts--wrap" aria-label="Send counts">
        <div>
          <dt>Messages</dt>
          <dd>{review.messages.length.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Left out</dt>
          <dd>{review.excluded.length.toLocaleString()}</dd>
        </div>
        {remaining !== null ? (
          <div>
            <dt>Daily cap remaining</dt>
            <dd>
              {remaining.toLocaleString()} <span className="muted counts__qualifier">of {cap.toLocaleString()} today</span>
            </dd>
          </div>
        ) : null}
      </dl>

      <ExcludedList excluded={review.excluded} />

      {review.messages.length === 0 ? (
        <p className="muted">No messages are included, so there is nothing to send. Reject to close this review.</p>
      ) : (
        <ol className="send-messages" aria-label="Messages to send">
          {review.messages.map((message, index) => (
            <MessageBlock
              key={message.intentId ?? index}
              message={message}
              position={index + 1}
              total={review.messages.length}
            />
          ))}
        </ol>
      )}

      {incomplete ? (
        <p className="inline-error" role="alert">
          A message in this approval is missing its recipient, subject, body, or sending inbox, so it cannot be read in
          full and cannot be approved. Reject it and prepare the send again.
        </p>
      ) : null}

      <p className="send-review__fixed">{SEND_REVIEW_FIXED_LINE}</p>
    </div>
  );
}

// What the compact agent panel shows instead of the messages. Sending is never decided from a surface that cannot
// show the full text.
export function SendReviewSummary({ review }: { review: SendReviewPayload }) {
  return (
    <div className="send-review">
      <p className="num">
        {messageCountLabel(review.messages.length)} waiting to be sent
        {review.excluded.length > 0 ? `, ${review.excluded.length.toLocaleString()} left out` : ''}.
      </p>
      <p>
        <Link className="link" to="/today">
          Open Today to review the full messages before deciding
        </Link>
      </p>
    </div>
  );
}
