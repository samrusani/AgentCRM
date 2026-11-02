import { Link } from 'react-router-dom';
import { useCompleteTask } from '../api/hooks';
import type { Task } from '../api/types';
import { describeDue } from '../lib/format';
import { recordLink } from '../lib/links';
import { errorMessage } from './common';

export function TaskRow({ task }: { task: Task }) {
  const complete = useCompleteTask();
  const due = describeDue(task.dueAt);
  const link = recordLink(task.entityType, task.entityId);
  const done = task.status === 'done' || complete.isSuccess;
  return (
    <li className="task">
      <input
        type="checkbox"
        className="task__check"
        id={`task-${task.id}`}
        checked={done}
        disabled={done || complete.isPending}
        onChange={() => complete.mutate({ id: task.id, expectedVersion: task.version })}
        aria-label={`Mark done: ${task.title}`}
      />
      <div className="task__text">
        <label htmlFor={`task-${task.id}`} className={`task__title${done ? ' is-done' : ''}`}>
          {task.title}
        </label>
        <span className="task__meta">
          {link && task.entityName ? (
            <Link className="link" to={link}>
              {task.entityName}
            </Link>
          ) : task.entityName ? (
            task.entityName
          ) : null}
        </span>
        {complete.isError ? (
          <span className="inline-error" role="alert">
            {errorMessage(complete.error)} The task is still open.
          </span>
        ) : null}
      </div>
      {task.dueAt ? (
        <span className={`task__due num${due.overdue ? ' is-overdue' : ''}`}>{due.text}</span>
      ) : null}
    </li>
  );
}
