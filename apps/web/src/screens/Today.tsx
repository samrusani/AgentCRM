import { useMemo, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useFollowupRules, useMailSummary, useMeetings, useSendIntents, useStartRun, useToday } from '../api/hooks';
import { ApprovalCard, useSettledApprovals } from '../components/approvals';
import { EmptyState, ErrorState, Loading, PageHeader, errorMessage } from '../components/common';
import { Followups } from '../components/followups';
import { LiveRun } from '../components/ledger';
import { Outbox } from '../components/outbox';
import { StagedBanner, type StagedNotice } from '../components/prepareSend';
import { Replies } from '../components/replies';
import { TaskRow } from '../components/TaskRow';
import { describeDue, formatBirthday } from '../lib/format';
import { recordLink } from '../lib/links';
import { isFollowupActive } from '../lib/mail';
import { attendeeLabel, formatClock, isTomorrow, todayAndTomorrowBounds } from '../lib/meetings';
import { useUI } from '../lib/ui';

// One Today section as a card. The title stays a real heading; the count sits beside it, not inside it, so the
// heading's name is unchanged. A zero count shows nothing.
function TodayCard({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
  return (
    <section className="today-card" aria-labelledby={id}>
      <header className="today-card__header">
        <h2 className="today-card__title" id={id}>
          {title}
        </h2>
        {count > 0 ? (
          <>
            <span className="today-card__count num">{count.toLocaleString()}</span>
            <span className="sr-only"> items</span>
          </>
        ) : null}
      </header>
      <div className="today-card__body">{children}</div>
    </section>
  );
}

export function Today() {
  const today = useToday();
  const navigate = useNavigate();
  const location = useLocation();
  const staged = (location.state as { staged?: StagedNotice } | null)?.staged ?? null;
  const startRun = useStartRun();
  const { pushToast } = useUI();
  const settled = useSettledApprovals();
  // The Outbox, Follow-ups, and Replies sections load their own data. These are the same cached queries, read here only
  // for the count beside each title.
  // They wait for the Today request, so a failed Today screen does not fire three more requests.
  const intents = useSendIntents(today.isSuccess);
  const followupRules = useFollowupRules({}, today.isSuccess);
  const mailSummary = useMailSummary(today.isSuccess);
  const outboxCount = (intents.data ?? []).filter((intent) => intent.status !== 'cancelled').length;
  const followupCount = (followupRules.data ?? []).filter(isFollowupActive).length;
  const replyCount = mailSummary.data?.repliesNeedingAttention ?? 0;
  // Today's and tomorrow's meetings in the viewer's zone. Fixed for the life of the screen so the query key holds still.
  const meetingBounds = useMemo(() => todayAndTomorrowBounds(), []);
  const meetings = useMeetings(meetingBounds);
  const meetingItems = meetings.data ?? [];

  const startDemo = () =>
    startRun.mutate(undefined, {
      onSuccess: (run) => navigate(`/research?run=${run.id}`),
      onError: (error) => pushToast(`Could not start the run. ${errorMessage(error)}`, 'error'),
    });

  if (today.isPending) {
    return (
      <div className="screen">
        <PageHeader title="Today" />
        <Loading what="today" />
      </div>
    );
  }
  if (today.isError) {
    return (
      <div className="screen">
        <PageHeader title="Today" />
        <ErrorState what="today" error={today.error} onRetry={() => void today.refetch()} />
      </div>
    );
  }

  const { tasksDue, approvalsPending, runsActive } = today.data;
  const birthdays = today.data.birthdays ?? [];
  const approvals = settled.merge(approvalsPending);
  const overdue = tasksDue.filter((task) => describeDue(task.dueAt).overdue);
  const dueToday = tasksDue.filter((task) => !describeDue(task.dueAt).overdue);

  return (
    <div className="screen">
      <PageHeader title="Today">
        <span className="muted num">
          {approvalsPending.length} waiting, {tasksDue.length} due, {runsActive.length} running
        </span>
      </PageHeader>

      <div className="today-area">
        <div className="today">
          <TodayCard id="today-approvals" title="Approvals waiting" count={approvalsPending.length}>
            {staged ? (
              <StagedBanner
                notice={staged}
                onDismiss={() => navigate(location.pathname, { replace: true, state: null })}
              />
            ) : null}
            {approvals.length === 0 ? (
              <EmptyState
                message="Nothing needs a decision. Agent proposals that need your approval will appear here."
                actionLabel="Start demo research"
                onAction={startDemo}
                busy={startRun.isPending}
              />
            ) : (
              <div className="stack">
                {approvals.map(({ approval, settled: entry }) => (
                  <ApprovalCard key={approval.id} approval={approval} settled={entry} onDecided={settled.record} />
                ))}
              </div>
            )}
          </TodayCard>

          <TodayCard id="today-outbox" title="Outbox" count={outboxCount}>
            <Outbox />
          </TodayCard>

          <TodayCard id="today-followups" title="Follow-ups" count={followupCount}>
            <Followups />
          </TodayCard>

          <TodayCard id="today-replies" title="Replies" count={replyCount}>
            <Replies tasks={tasksDue} />
          </TodayCard>

          <TodayCard id="today-tasks" title="Tasks due and overdue" count={tasksDue.length}>
            {tasksDue.length === 0 ? (
              <EmptyState
                message="No tasks are due. Tasks dated today or earlier will appear here."
                actionLabel="Open relationships"
                onAction={() => navigate('/relationships')}
              />
            ) : (
              <>
                {overdue.length > 0 ? (
                  <>
                    <h3 className="subsection__title">
                      Overdue <span className="num muted">{overdue.length}</span>
                    </h3>
                    <ul className="task-list">
                      {overdue.map((task) => (
                        <TaskRow key={task.id} task={task} />
                      ))}
                    </ul>
                  </>
                ) : null}
                {dueToday.length > 0 ? (
                  <>
                    <h3 className="subsection__title">
                      Due today <span className="num muted">{dueToday.length}</span>
                    </h3>
                    <ul className="task-list">
                      {dueToday.map((task) => (
                        <TaskRow key={task.id} task={task} />
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            )}
          </TodayCard>

          <TodayCard id="today-runs" title="Active runs" count={runsActive.length}>
            {runsActive.length === 0 ? (
              <EmptyState
                message="No runs are active. Research runs show a live ledger here while they work."
                actionLabel="Start demo research"
                onAction={startDemo}
                busy={startRun.isPending}
              />
            ) : (
              <div className="stack">
                {runsActive.map((run) => (
                  <LiveRun key={run.id} run={run} />
                ))}
              </div>
            )}
          </TodayCard>

          <TodayCard id="today-birthdays" title="Birthdays" count={birthdays.length}>
            {birthdays.length === 0 ? (
              <EmptyState message="No birthdays in the next seven days. Add birthdays on a person's sheet." />
            ) : (
              <ul className="task-list">
                {birthdays.map((birthday) => (
                  <li key={birthday.personId} className="task">
                    <div className="task__text">
                      <span className="task__title">
                        <Link className="link" to={recordLink('person', birthday.personId) ?? '#'}>
                          {birthday.name}
                        </Link>
                      </span>
                      <span className="task__meta">
                        {birthday.turns !== undefined
                          ? `Turns ${birthday.turns} on ${formatBirthday(birthday.date.slice(5))}`
                          : `Birthday on ${formatBirthday(birthday.date.slice(5))}`}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </TodayCard>

          <TodayCard id="today-meetings" title="Meetings" count={meetingItems.length}>
            {meetings.isError ? (
              <ErrorState what="meetings" error={meetings.error} onRetry={() => void meetings.refetch()} />
            ) : meetings.isPending ? (
              <Loading what="meetings" />
            ) : meetingItems.length === 0 ? (
              <EmptyState message="Nothing scheduled for today or tomorrow." />
            ) : (
              <ul className="task-list">
                {meetingItems.map((meeting) => (
                  <li key={meeting.id} className="task">
                    <div className="task__text">
                      <span className="task__title">
                        <Link className="link" to={`/meetings?meeting=${encodeURIComponent(meeting.id)}`}>
                          {meeting.title}
                        </Link>
                      </span>
                      <span className="task__meta">{attendeeLabel(meeting.attendeeCount)}</span>
                    </div>
                    <span className="task__due num">
                      {isTomorrow(meeting.startsAt) ? `Tomorrow ${formatClock(meeting.startsAt)}` : formatClock(meeting.startsAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </TodayCard>
        </div>
      </div>
    </div>
  );
}
