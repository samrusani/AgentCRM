import { useEffect, useState, type FormEvent } from 'react';
import { useRemoveBackblazeConnector, useRunBackup, useSaveBackblazeConnector } from '../api/hooks';
import type { BackblazeSettings, Connector } from '../api/types';
import { errorMessage } from '../components/common';
import { CONNECTOR_MARKS, CardToggle, RemoveControl, TokenLine, useCardOpen, type CardState } from '../components/connector';
import { formatAgo } from '../lib/format';

const DEFAULT_KEEP = 14;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// One line in plain words about the newest backup state.
export function backupStatusLine(settings: BackblazeSettings): string {
  if (settings.runRequestedAt) return 'A backup is queued.';
  const result = settings.lastResult;
  if (!result) return 'No backup has run yet.';
  if (!result.ok) return result.error ?? 'The last backup failed.';
  const size = result.bytes !== null ? `, ${formatSize(result.bytes)}` : '';
  // A backup that uploaded but could not prune still says so, otherwise the bucket grows past the keep count unseen.
  const pruneProblem = result.error ? ` ${result.error}` : '';
  return `Last backup ${formatAgo(result.at)}${size}.${pruneProblem}`;
}

function cardState(connector: Connector | null): CardState {
  if (connector?.status === 'error') return { tone: 'danger', label: 'Error' };
  return connector ? { tone: 'neutral', label: 'Connected' } : { tone: 'off', label: 'Not connected' };
}

function ConnectForm({ connector }: { connector: Connector | null }) {
  const save = useSaveBackblazeConnector();
  const saved = connector?.backblaze ?? null;
  const [keyId, setKeyId] = useState(saved?.keyId ?? '');
  const [applicationKey, setApplicationKey] = useState('');
  const [bucketName, setBucketName] = useState(saved?.bucketName ?? '');
  const [keep, setKeep] = useState(String(saved?.keep ?? DEFAULT_KEEP));
  const reconnecting = Boolean(connector);
  const keepNumber = Number(keep);
  const ready = keyId.trim() !== '' && applicationKey.trim() !== '' && bucketName.trim() !== '' && Number.isInteger(keepNumber) && keepNumber >= 1 && keepNumber <= 365;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || save.isPending) return;
    try {
      await save.mutateAsync({ keyId: keyId.trim(), applicationKey: applicationKey.trim(), bucketName: bucketName.trim(), keep: keepNumber });
      setApplicationKey('');
    } catch {
      // The refusal sentence shows below the form.
    }
  };

  return (
    <form className="connector__form" onSubmit={(event) => void submit(event)}>
      <label className="connector__label" htmlFor="backblaze-key-id">
        Key ID
      </label>
      <input id="backblaze-key-id" className="input" type="text" autoComplete="off" spellCheck={false} value={keyId} onChange={(event) => setKeyId(event.target.value)} />
      <label className="connector__label" htmlFor="backblaze-token">
        Application key
      </label>
      <input
        id="backblaze-token"
        className="input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={applicationKey}
        onChange={(event) => setApplicationKey(event.target.value)}
        aria-describedby="backblaze-token-note"
      />
      <p className="muted" id="backblaze-token-note">
        The key is stored unencrypted in the local database file on this computer and is sent only to Backblaze. Anyone who can read that file can read the key.
      </p>
      <label className="connector__label" htmlFor="backblaze-bucket">
        Bucket name
      </label>
      <input id="backblaze-bucket" className="input" type="text" autoComplete="off" spellCheck={false} value={bucketName} onChange={(event) => setBucketName(event.target.value)} />
      <label className="connector__label" htmlFor="backblaze-keep">
        Keep count
      </label>
      <div className="connector__row">
        <input id="backblaze-keep" className="input num" type="number" min={1} max={365} step={1} value={keep} onChange={(event) => setKeep(event.target.value)} />
        <button type="submit" className="btn btn--primary" disabled={!ready || save.isPending}>
          {save.isPending ? 'Checking key...' : reconnecting ? 'Reconnect' : 'Connect'}
        </button>
      </div>
      {save.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(save.error)}
        </p>
      ) : null}
    </form>
  );
}

function KeepField({ saved }: { saved: number }) {
  const save = useSaveBackblazeConnector();
  const [keep, setKeep] = useState(String(saved));
  useEffect(() => setKeep(String(saved)), [saved]);
  const keepNumber = Number(keep);
  const valid = keep.trim() !== '' && Number.isInteger(keepNumber) && keepNumber >= 1 && keepNumber <= 365;
  const dirty = valid && keepNumber !== saved;
  return (
    <div className="connector__form">
      <label className="connector__label" htmlFor="backblaze-keep">
        Keep count
      </label>
      <div className="connector__row">
        <input id="backblaze-keep" className="input num" type="number" min={1} max={365} step={1} value={keep} onChange={(event) => setKeep(event.target.value)} />
        <button type="button" className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate({ keep: keepNumber })}>
          {save.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
      <p className="muted">Uploads and local snapshots beyond this many are deleted after each backup. Use a number from 1 to 365.</p>
      {save.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(save.error)} The keep count did not change.
        </p>
      ) : null}
    </div>
  );
}

export function BackblazeCard({ connector }: { connector: Connector | null }) {
  const remove = useRemoveBackblazeConnector();
  const run = useRunBackup();
  const [open, toggle] = useCardOpen(connector);
  const settings = connector?.backblaze ?? null;
  const hasError = connector?.status === 'error';
  const queued = Boolean(settings?.runRequestedAt);

  return (
    <article className="connector" aria-label="Backblaze backups connector">
      <CardToggle
        name="Backblaze backups"
        mark={CONNECTOR_MARKS.backblaze ?? 'Bz'}
        summary={settings?.bucketName ?? null}
        state={cardState(connector)}
        open={open}
        onToggle={toggle}
        bodyId="backblaze-card-body"
      />

      {open ? (
        <div className="connector__body" id="backblaze-card-body">
          {connector && settings ? (
            <>
              <TokenLine connector={connector} noun="key" />
              <p>
                Bucket <span className="cell-name">{settings.bucketName ?? 'unknown'}</span>
              </p>
              {hasError ? (
                <p className="inline-error" role="alert">
                  {connector.statusMessage ?? 'Backblaze rejected the saved application key. Enter a new one to reconnect.'}
                </p>
              ) : null}
              <KeepField saved={settings.keep} />
              <p role="status">{backupStatusLine(settings)}</p>
              <div className="connector__row">
                <button type="button" className="btn" disabled={queued || run.isPending || hasError} onClick={() => run.mutate()}>
                  {run.isPending ? 'Queuing...' : 'Back up now'}
                </button>
              </div>
              {run.isError ? (
                <p className="inline-error" role="alert">
                  {errorMessage(run.error)} No backup was queued.
                </p>
              ) : null}
              {hasError ? <ConnectForm connector={connector} /> : null}
            </>
          ) : (
            <ConnectForm connector={null} />
          )}

          <p className="muted">A backup is the whole database, connector keys included. Keep the bucket private.</p>
          <p className="muted">Backups run daily while AgentCRM is open; a missed day is caught up the next time it starts.</p>

          {connector ? (
            <RemoveControl
              provider="Backblaze backups"
              mutation={{ isPending: remove.isPending, isError: remove.isError, error: remove.error, mutate: () => remove.mutate() }}
              warning="Remove Backblaze backups and delete the stored key? Nothing already uploaded is deleted."
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
