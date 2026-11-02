import { useState } from 'react';
import { useLiftSuppression } from '../api/hooks';
import { errorMessage } from './common';

// Lifting a suppression lets the address be emailed again, so it asks once and says what it does.
export function LiftSuppressionControl({ suppressionId, email }: { suppressionId: string; email: string }) {
  const lift = useLiftSuppression();
  const [confirming, setConfirming] = useState(false);

  if (lift.isSuccess) {
    return (
      <span className="muted" role="status">
        Suppression lifted.
      </span>
    );
  }

  return (
    <span className="lift">
      {confirming ? (
        <span className="lift__confirm" role="alert">
          Lift the suppression for {email}? They can be emailed again.
          <button
            type="button"
            className="btn btn--danger"
            disabled={lift.isPending}
            onClick={() => lift.mutate(suppressionId)}
          >
            {lift.isPending ? 'Lifting...' : 'Lift suppression'}
          </button>
          <button type="button" className="btn" disabled={lift.isPending} onClick={() => setConfirming(false)}>
            Keep suppressed
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={() => setConfirming(true)}
          aria-label={`Lift suppression for ${email}`}
        >
          Lift suppression
        </button>
      )}
      {lift.isError ? (
        <span className="inline-error" role="alert">
          {errorMessage(lift.error)} The suppression is still in place.
        </span>
      ) : null}
    </span>
  );
}
