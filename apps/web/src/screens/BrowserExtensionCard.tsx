import { useState } from 'react';
import { useCaptureSettings, useGenerateCaptureToken, useRemoveCaptureToken } from '../api/hooks';
import { ErrorState, Loading, errorMessage } from '../components/common';
import { CONNECTOR_MARKS, CardToggle, useCardOpen } from '../components/connector';
import { formatAgo, formatDate } from '../lib/format';

// Shows the plaintext token exactly once, right after generating. The server keeps only a hash,
// so once this unmounts the token cannot be read again.
function TokenReveal({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The field below stays selectable for a manual copy.
    }
  };
  return (
    <div className="connector__form">
      <label className="connector__label" htmlFor="capture-token-value">
        Capture token
      </label>
      <div className="connector__row">
        <input
          id="capture-token-value"
          className="input num"
          type="text"
          readOnly
          value={token}
          spellCheck={false}
          onFocus={(event) => event.target.select()}
          aria-describedby="capture-token-once"
        />
        <button type="button" className="btn btn--primary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="muted" id="capture-token-once">
        Copy it now. It is not shown again; generating a new one replaces it.
      </p>
    </div>
  );
}

function RotateControl({ onRotate, busy }: { onRotate: () => void; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="btn btn--quiet" onClick={() => setConfirming(true)}>
        Generate new token
      </button>
    );
  }
  return (
    <span className="run-controls__confirm" role="alert">
      Generate a new token? The current one stops working immediately and the extension needs the new one.
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        onClick={() => {
          onRotate();
          setConfirming(false);
        }}
      >
        {busy ? 'Generating...' : 'Generate new token'}
      </button>
      <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>
        Keep the current one
      </button>
    </span>
  );
}

function RemoveTokenControl({ onRemoved }: { onRemoved: () => void }) {
  const remove = useRemoveCaptureToken();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="connector__remove">
      {confirming ? (
        <span className="run-controls__confirm" role="alert">
          Remove the capture token? The extension stops working until you generate a new one.
          <button
            type="button"
            className="btn btn--danger"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  setConfirming(false);
                  // A token revealed earlier stopped working the moment the hash was removed, so it must not stay on screen.
                  onRemoved();
                },
              })
            }
          >
            {remove.isPending ? 'Removing...' : 'Remove token'}
          </button>
          <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={remove.isPending}>
            Keep it
          </button>
        </span>
      ) : (
        <button type="button" className="btn btn--quiet" onClick={() => setConfirming(true)}>
          Remove
        </button>
      )}
      {remove.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(remove.error)} The token is still in place.
        </p>
      ) : null}
    </div>
  );
}

export function BrowserExtensionCard() {
  const settings = useCaptureSettings();
  const generate = useGenerateCaptureToken();
  const [open, toggle] = useCardOpen(null);
  // Loading and error are their own states: treating them as "not configured" would offer a Generate
  // button that rotates a live token the card simply has not seen yet.
  const configured = settings.isSuccess && settings.data.configured;
  const state = settings.isSuccess
    ? configured
      ? { tone: 'neutral' as const, label: 'Configured' }
      : { tone: 'off' as const, label: 'Not configured' }
    : settings.isError
      ? { tone: 'danger' as const, label: 'Error' }
      : { tone: 'off' as const, label: 'Checking' };

  return (
    <article className="connector" aria-label="Browser extension">
      <CardToggle
        name="Browser extension"
        mark={CONNECTOR_MARKS.extension}
        summary={configured && settings.data?.createdAt ? `Token created ${formatAgo(settings.data.createdAt)}` : null}
        state={state}
        open={open}
        onToggle={toggle}
        bodyId="capture-card-body"
      />
      {open && settings.isPending ? (
        <div className="connector__body" id="capture-card-body">
          <Loading what="capture settings" />
        </div>
      ) : null}
      {open && settings.isError ? (
        <div className="connector__body" id="capture-card-body">
          <ErrorState what="capture settings" error={settings.error} onRetry={() => void settings.refetch()} />
        </div>
      ) : null}
      {open && settings.isSuccess ? (
        <div className="connector__body" id="capture-card-body">
          {!configured ? (
            <>
              <p className="muted">
                Capture people from LinkedIn and X profile pages with one click, straight into this CRM.
              </p>
              <ol className="muted connector__howto-steps">
                <li>Build the extension: npm install, then npm run build, inside apps/extension.</li>
                <li>Open chrome://extensions, turn on Developer mode, choose Load unpacked, and pick the apps/extension folder.</li>
                <li>Generate a token below and paste it, with the server address, into the extension's options page.</li>
              </ol>
            </>
          ) : (
            <p className="connector__token">
              Token created {formatDate(settings.data?.createdAt ?? null)}. Only a hash is stored; the token itself
              cannot be shown again.
            </p>
          )}

          {generate.data ? <TokenReveal token={generate.data.token} /> : null}

          {!configured ? (
            <div>
              <button
                type="button"
                className="btn btn--primary"
                disabled={generate.isPending}
                onClick={() => generate.mutate()}
              >
                {generate.isPending ? 'Generating...' : 'Generate token'}
              </button>
            </div>
          ) : (
            <div className="connector__row">
              <RotateControl onRotate={() => generate.mutate()} busy={generate.isPending} />
              <RemoveTokenControl onRemoved={() => generate.reset()} />
            </div>
          )}

          {generate.isError ? (
            <p className="inline-error" role="alert">
              {errorMessage(generate.error)}
            </p>
          ) : null}

          <p className="muted">
            The extension captures a profile only when you click. Viewing a profile checks it against your CRM so the
            button can say In CRM, and that check only ever talks to a local server address. Nothing else runs in the
            background.
          </p>
        </div>
      ) : null}
    </article>
  );
}
