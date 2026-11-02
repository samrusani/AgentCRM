import { useId } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMailReadiness, useStageSend } from '../api/hooks';
import type { SendExcluded, StageSendInput } from '../api/types';
import { messageCountLabel, parseSendReviewPayload } from '../lib/mail';
import { errorMessage } from './common';
import { ExcludedList } from './sendReview';

export interface StagedNotice {
  messageCount: number;
  excluded: SendExcluded[];
}

// Starts the send review for saved drafts. This only creates a review on Today: nothing is sent until the exact
// messages are approved there.
export function PrepareToSend({
  label,
  input,
  quiet = false,
}: {
  label: string;
  input: StageSendInput;
  quiet?: boolean;
}) {
  const readiness = useMailReadiness();
  const stage = useStageSend();
  const navigate = useNavigate();
  const noteId = useId();

  const blocked = readiness.state === 'blocked' ? readiness : null;
  const disabled = readiness.state !== 'ready' || stage.isPending;

  const prepare = () => {
    if (disabled) return;
    stage.mutate(input, {
      onSuccess: (result) => {
        if (!result.approval) return;
        const messageCount = parseSendReviewPayload(result.approval.payload).messages.length;
        const notice: StagedNotice = { messageCount, excluded: result.excluded };
        navigate('/today', { state: { staged: notice } });
      },
    });
  };

  // No approval came back: everything was left out, and the reasons stay on screen here.
  const nothingStaged = stage.isSuccess && stage.data.approval === null;

  return (
    <div className="prepare-send">
      <button
        type="button"
        className={quiet ? 'btn btn--quiet' : 'btn'}
        onClick={prepare}
        disabled={disabled}
        aria-describedby={blocked ? noteId : undefined}
      >
        {stage.isPending ? 'Preparing...' : label}
      </button>
      {blocked ? (
        <p className="muted" id={noteId}>
          {blocked.message}{' '}
          {blocked.settingsLink ? (
            <Link className="link" to="/settings/connectors">
              Open Settings
            </Link>
          ) : null}
        </p>
      ) : null}
      {stage.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(stage.error)} Nothing was prepared.
        </p>
      ) : null}
      {nothingStaged ? (
        <div role="status">
          <p>No message can be sent. Everyone in this selection was left out.</p>
          <ExcludedList excluded={stage.data.excluded} />
        </div>
      ) : null}
    </div>
  );
}

export function StagedBanner({ notice, onDismiss }: { notice: StagedNotice; onDismiss: () => void }) {
  return (
    <section className="staged-banner" aria-label="Send review prepared" role="status">
      <p>
        <span className="cell-name num">{messageCountLabel(notice.messageCount)}</span> prepared for review below.
        Nothing is sent until you approve the exact text.
        {notice.excluded.length > 0 ? ' Some people were left out:' : ''}
      </p>
      <ExcludedList excluded={notice.excluded} />
      <button type="button" className="btn btn--quiet" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}
