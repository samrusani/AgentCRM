import { useState } from 'react';
import { useStageMailbox } from '../api/hooks';
import type { Run } from '../api/types';
import { Sheet, errorMessage } from '../components/common';
import { SheetSection } from '../components/record';

// The windows the sheet offers. "All" sends no sinceDays.
const WINDOWS: Array<{ value: string; label: string; sinceDays: number | undefined }> = [
  { value: 'all', label: 'All synced mail', sinceDays: undefined },
  { value: '90', label: 'Last 90 days', sinceDays: 90 },
  { value: '30', label: 'Last 30 days', sinceDays: 30 },
];

export function MailboxCaptureSheet({ onClose, onStaged }: { onClose: () => void; onStaged: (run: Run) => void }) {
  const stage = useStageMailbox();
  const [window, setWindow] = useState('all');

  const submit = () => {
    const sinceDays = WINDOWS.find((entry) => entry.value === window)?.sinceDays;
    stage.mutate(sinceDays === undefined ? {} : { sinceDays }, { onSuccess: onStaged });
  };

  return (
    <Sheet title="Scan mailbox" onClose={onClose}>
      <SheetSection title="Mail to scan">
        <p className="muted">Reads only mail already synced to this computer. Nothing is fetched, sent, or billed.</p>
        <div className="field">
          <label className="field__label" htmlFor="mailbox-window">
            Window
          </label>
          <select
            id="mailbox-window"
            className="input input--select"
            value={window}
            disabled={stage.isPending}
            onChange={(event) => setWindow(event.target.value)}
          >
            {WINDOWS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        {stage.isError ? (
          <p className="inline-error" role="alert">
            {errorMessage(stage.error)} Nothing was staged.
          </p>
        ) : null}
        <div className="sheet-actions">
          <button type="button" className="btn btn--primary" onClick={submit} disabled={stage.isPending}>
            {stage.isPending ? 'Staging...' : 'Stage people for review'}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={stage.isPending}>
            Cancel
          </button>
        </div>
      </SheetSection>
    </Sheet>
  );
}
