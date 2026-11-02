import { Link } from 'react-router-dom';
import { useMailSummary, useSuppressions } from '../api/hooks';
import type { MailReply, Suppression, Task } from '../api/types';
import { formatAgo } from '../lib/format';
import { recordLink } from '../lib/links';
import { EmptyState, ErrorState, Loading, Chip } from './common';
import { LiftSuppressionControl } from './liftSuppression';

// The server creates a task to respond, or to review an opt out. Match it by person when the reply does not name it.
const REPLY_TASK = /repl|respond|opt.?out|unsubscribe|suppress/i;

function taskFor(reply: MailReply, tasks: Task[]): string | null {
  if (reply.taskTitle) return reply.taskTitle;
  if (!reply.personId) return null;
  const match = tasks.find(
    (task) =>
      task.status === 'open' &&
      task.entityType === 'person' &&
      task.entityId === reply.personId &&
      REPLY_TASK.test(task.title),
  );
  return match?.title ?? null;
}

function findSuppression(reply: MailReply, suppressions: Suppression[]): Suppression | null {
  if (reply.suppressionId) {
    const byId = suppressions.find((entry) => entry.id === reply.suppressionId);
    if (byId) return byId;
  }
  const email = reply.fromEmail?.toLowerCase();
  if (!email) return null;
  return suppressions.find((entry) => entry.email.toLowerCase() === email && entry.reason === 'opt_out') ?? null;
}

function ReplyRow({
  reply,
  tasks,
  suppressions,
  suppressionsLoaded,
}: {
  reply: MailReply;
  tasks: Task[];
  suppressions: Suppression[];
  suppressionsLoaded: boolean;
}) {
  const link = recordLink('person', reply.personId);
  const name = reply.personName ?? reply.fromEmail ?? 'Unknown sender';
  const task = taskFor(reply, tasks);
  const suppression = reply.optOut ? findSuppression(reply, suppressions) : null;

  return (
    <li className="reply-row">
      <div className="reply-row__head">
        <span className="cell-name">{name}</span>
        {reply.personName && reply.fromEmail ? <span className="muted">{reply.fromEmail}</span> : null}
        {reply.optOut ? <Chip tone="warn">Opt out detected</Chip> : null}
        {reply.receivedAt ? <span className="muted num reply-row__age">{formatAgo(reply.receivedAt)}</span> : null}
      </div>
      {reply.subject ? <p className="reply-row__subject">{reply.subject}</p> : null}
      {reply.preview ? <p className="reply-row__preview">{reply.preview}</p> : null}
      {reply.optOut ? (
        <div className="reply-row__optout">
          <p>
            {reply.matchedWording ? (
              <>
                Matched wording: <span className="cell-name">{`"${reply.matchedWording}"`}</span>.{' '}
              </>
            ) : (
              'The reply matched opt out wording. '
            )}
            {suppression
              ? `${suppression.email} is suppressed and will not be emailed.`
              : suppressionsLoaded
                ? 'No active suppression was found for this address.'
                : ''}
          </p>
          {suppression ? <LiftSuppressionControl suppressionId={suppression.id} email={suppression.email} /> : null}
        </div>
      ) : null}
      {task ? <p className="muted">Task: {task}</p> : null}
      <div className="reply-row__actions">
        {link ? (
          <Link className="btn" to={link}>
            Open record
          </Link>
        ) : (
          <span className="muted">This sender is not linked to a person.</span>
        )}
      </div>
    </li>
  );
}

export function Replies({ tasks }: { tasks: Task[] }) {
  const summary = useMailSummary();
  const suppressions = useSuppressions();

  if (summary.isPending) return <Loading what="replies" />;
  if (summary.isError) {
    return <ErrorState what="replies" error={summary.error} onRetry={() => void summary.refetch()} />;
  }

  const { replies, repliesNeedingAttention } = summary.data;
  const sorted = [...replies].sort((a, b) => Date.parse(b.receivedAt ?? '') - Date.parse(a.receivedAt ?? '') || 0);

  if (repliesNeedingAttention === 0) {
    return (
      <EmptyState message="No replies need attention. Replies from people you emailed appear here with the task to respond." />
    );
  }

  return (
    <>
      <p className="muted num">
        {repliesNeedingAttention.toLocaleString()} {repliesNeedingAttention === 1 ? 'reply needs' : 'replies need'} attention
      </p>
      {sorted.length === 0 ? (
        <p className="muted">
          The server counted these replies but did not list them. Open the person from the task list to read the
          reply in their timeline.
        </p>
      ) : (
        <ul className="reply-list">
          {sorted.map((reply) => (
            <ReplyRow
              key={reply.id}
              reply={reply}
              tasks={tasks}
              suppressions={suppressions.data ?? []}
              suppressionsLoaded={suppressions.isSuccess}
            />
          ))}
        </ul>
      )}
    </>
  );
}
