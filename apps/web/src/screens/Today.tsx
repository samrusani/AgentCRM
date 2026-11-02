import { useNavigate } from 'react-router-dom';
import { useStartRun, useToday } from '../api/hooks';
import { ApprovalCard, useSettledApprovals } from '../components/approvals';
import { EmptyState, ErrorState, Loading, PageHeader, errorMessage } from '../components/common';
import { LiveRun } from '../components/ledger';
import { TaskRow } from '../components/TaskRow';
import { describeDue } from '../lib/format';
import { useUI } from '../lib/ui';

export function Today() {
  const today = useToday();
  const navigate = useNavigate();
  const startRun = useStartRun();
  const { pushToast } = useUI();
  const settled = useSettledApprovals();

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

      <div className="today">
        <section className="section" aria-labelledby="today-approvals">
          <h2 className="section__title" id="today-approvals">
            Approvals waiting
          </h2>
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
        </section>

        <section className="section" aria-labelledby="today-tasks">
          <h2 className="section__title" id="today-tasks">
            Tasks due and overdue
          </h2>
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
        </section>

        <section className="section" aria-labelledby="today-runs">
          <h2 className="section__title" id="today-runs">
            Active runs
          </h2>
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
        </section>
      </div>
    </div>
  );
}
