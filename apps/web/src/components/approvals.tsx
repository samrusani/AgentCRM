import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDecideApproval } from '../api/hooks';
import type { Approval } from '../api/types';
import { formatDateTime, isSimulatedApproval, summarizePayload } from '../lib/format';
import { SimulatedChip, errorMessage } from './common';

export interface Settled {
  approval: Approval;
  decision: 'approve' | 'reject';
  at: string;
}

// Keeps a decided approval on screen as a one line record after the pending
// list refetches without it.
export function useSettledApprovals() {
  const [settled, setSettled] = useState<Record<string, Settled>>({});
  const record = (approval: Approval, decision: 'approve' | 'reject') =>
    setSettled((current) => ({
      ...current,
      [approval.id]: { approval, decision, at: new Date().toISOString() },
    }));
  const merge = (pending: Approval[]): Array<{ approval: Approval; settled?: Settled }> => {
    const pendingIds = new Set(pending.map((approval) => approval.id));
    return [
      ...pending.map((approval) => ({ approval, settled: settled[approval.id] })),
      ...Object.values(settled)
        .filter((entry) => !pendingIds.has(entry.approval.id))
        .map((entry) => ({ approval: entry.approval, settled: entry })),
    ];
  };
  return { record, merge };
}

export function ApprovalCard({
  approval,
  settled,
  onDecided,
  compact,
}: {
  approval: Approval;
  settled?: Settled;
  onDecided?: (approval: Approval, decision: 'approve' | 'reject') => void;
  compact?: boolean;
}) {
  const decide = useDecideApproval();
  const [pendingDecision, setPendingDecision] = useState<'approve' | 'reject' | null>(null);

  const decision =
    settled?.decision ??
    (approval.status === 'approved' ? 'approve' : approval.status === 'rejected' ? 'reject' : null);

  if (decision) {
    const at = settled?.at ?? approval.decidedAt;
    return (
      <div className="approval approval--settled">
        <span className="approval__verdict">{decision === 'approve' ? 'Approved' : 'Rejected'}</span>
        <span className="approval__settled-title">{approval.title}</span>
        {at ? <span className="muted num">{formatDateTime(at)}</span> : null}
      </div>
    );
  }

  const lines = summarizePayload(approval.payload);

  const submit = (next: 'approve' | 'reject') => {
    setPendingDecision(next);
    decide.mutate(
      { id: approval.id, decision: next },
      {
        onSuccess: () => onDecided?.(approval, next),
        onSettled: () => setPendingDecision(null),
      },
    );
  };

  return (
    <article className={`approval${compact ? ' approval--compact' : ''}`} aria-label={`Approval: ${approval.title}`}>
      <header className="approval__header">
        <h3 className="approval__title">{approval.title}</h3>
        {isSimulatedApproval(approval) ? <SimulatedChip /> : null}
      </header>
      <p className="approval__meta">
        Needs your decision
        {approval.runTitle ? (
          <>
            {' '}
            from{' '}
            {approval.runId ? (
              <Link className="link" to={`/research?run=${approval.runId}`}>
                {approval.runTitle}
              </Link>
            ) : (
              approval.runTitle
            )}
          </>
        ) : null}
      </p>
      {lines.length > 0 ? (
        <ul className="approval__payload">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {decide.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(decide.error)} The approval is still pending.
        </p>
      ) : null}
      <div className="approval__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => submit('approve')}
          disabled={decide.isPending}
          aria-label={`Approve ${approval.title}`}
        >
          {pendingDecision === 'approve' ? 'Approving...' : 'Approve'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => submit('reject')}
          disabled={decide.isPending}
          aria-label={`Reject ${approval.title}`}
        >
          {pendingDecision === 'reject' ? 'Rejecting...' : 'Reject'}
        </button>
      </div>
    </article>
  );
}
