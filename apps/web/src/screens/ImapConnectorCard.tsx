import { useState, type FormEvent } from 'react';
import { useImapConnector, useMailProvider, useRemoveImapConnector, useSaveImapConnector } from '../api/hooks';
import type { Connector, ImapConnectorInput, ImapPreset, SmtpTls } from '../api/types';
import { errorMessage } from '../components/common';
import { CONNECTOR_MARKS, CardToggle, RemoveControl, useCardOpen } from '../components/connector';
import { UseMailProvider, mailCardState, mailConnectorReady } from '../components/mailProvider';
import { formatAgo } from '../lib/format';
import { DAILY_SEND_CAP, mailProviderName } from '../lib/mail';

interface PresetInfo {
  label: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  smtpTls: SmtpTls;
}

// What the presets fill in. The server owns the real values; these only show them read only.
const PRESETS: Record<Exclude<ImapPreset, 'custom'>, PresetInfo> = {
  icloud: {
    label: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: '993',
    smtpHost: 'smtp.mail.me.com',
    smtpPort: '587',
    smtpTls: 'starttls',
  },
  fastmail: {
    label: 'Fastmail',
    imapHost: 'imap.fastmail.com',
    imapPort: '993',
    smtpHost: 'smtp.fastmail.com',
    smtpPort: '465',
    smtpTls: 'tls',
  },
};

const TLS_LABELS: Record<string, string> = { tls: 'TLS', starttls: 'STARTTLS' };

function tlsLabel(mode: string | null): string {
  return mode ? (TLS_LABELS[mode] ?? mode) : 'TLS mode unknown';
}

function PresetHint({ preset }: { preset: ImapPreset }) {
  if (preset === 'icloud') {
    return (
      <>
        <p className="muted">
          Create an app password at account.apple.com: Sign-In and Security, App-Specific Passwords. Apple requires two
          factor authentication on the account first.
        </p>
        <p className="muted">
          The IMAP login uses the part of the address before the @ automatically. SMTP uses the full address.
        </p>
      </>
    );
  }
  if (preset === 'fastmail') {
    return (
      <>
        <p className="muted">
          Create an app password in Fastmail: Settings, Privacy &amp; Security, New app password.
        </p>
        <p className="muted">
          Fastmail&apos;s Basic plan has no IMAP or SMTP access, so connecting fails on that plan.
        </p>
      </>
    );
  }
  return (
    <p className="muted">
      Use the servers and an app password from your mail provider. If your provider offers app passwords, prefer one over
      your account password.
    </p>
  );
}

// One sentence on the provider's documented sending limits, then the app's own cap.
function LimitsSentence({ preset }: { preset: ImapPreset }) {
  const own = (
    <>
      This app also stops at <span className="num">{DAILY_SEND_CAP}</span> accepted sends per inbox per day.
    </>
  );
  if (preset === 'fastmail') {
    return (
      <p className="muted">
        Fastmail publishes daily sending limits that depend on your plan and counts each recipient of a message. {own}
      </p>
    );
  }
  if (preset === 'icloud') {
    return <p className="muted">Apple does not publish a daily sending limit for iCloud Mail. {own}</p>;
  }
  return <p className="muted">Your provider sets its own sending limits, so check them with the provider. {own}</p>;
}

function checksLine(connector: Connector): string | null {
  if (!connector.imap) return null;
  const { imapOk, smtpOk } = connector.imap;
  return `IMAP login ${imapOk ? 'verified' : 'not verified'}. SMTP ${smtpOk ? 'verified' : 'not verified'}.`;
}

function SentMailboxControl({ connector }: { connector: Connector }) {
  const save = useSaveImapConnector();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const imap = connector.imap;
  if (!imap) return null;
  const current = imap.sentMailbox;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value || save.isPending || !imap.preset || !connector.emailAddress) return;
    save.mutate(
      { preset: imap.preset, address: connector.emailAddress, sentMailbox: value },
      { onSuccess: () => setEditing(false) },
    );
  };

  return (
    <div className="connector__form">
      {editing ? (
        <form className="connector__form" onSubmit={submit}>
          <label className="connector__label" htmlFor="imap-sent-mailbox">
            Sent mailbox
          </label>
          <div className="connector__row">
            <input
              id="imap-sent-mailbox"
              className="input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-describedby="imap-sent-note"
            />
            <button type="submit" className="btn" disabled={save.isPending || draft.trim() === ''}>
              {save.isPending ? 'Saving...' : 'Save'}
            </button>
            <button type="button" className="btn btn--quiet" disabled={save.isPending} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          <p className="muted" id="imap-sent-note">
            Type the mailbox name exactly as your provider shows it. The app files a copy of each sent message here.
          </p>
        </form>
      ) : (
        <p>
          Sent mailbox{' '}
          <span className="cell-name">{current ?? 'not found'}</span>{' '}
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              setDraft(current ?? '');
              save.reset();
              setEditing(true);
            }}
          >
            Change
          </button>
        </p>
      )}
      {save.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(save.error)} The Sent mailbox did not change.
        </p>
      ) : save.data?.status === 'error' ? (
        <p className="inline-error" role="alert">
          {save.data.statusMessage ?? 'The Sent mailbox could not be checked.'}
        </p>
      ) : null}
    </div>
  );
}

function ImapForm({
  connector,
  preset,
  onPresetChange,
  onDone,
}: {
  connector: Connector | null;
  preset: ImapPreset;
  onPresetChange: (preset: ImapPreset) => void;
  onDone: () => void;
}) {
  const save = useSaveImapConnector();
  const stored = connector?.imap ?? null;

  const [address, setAddress] = useState(connector?.emailAddress ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState(stored?.preset === 'custom' ? (stored.servers.imapHost ?? '') : '');
  const [imapPort, setImapPort] = useState(stored?.preset === 'custom' ? String(stored.servers.imapPort ?? '993') : '993');
  const [smtpHost, setSmtpHost] = useState(stored?.preset === 'custom' ? (stored.servers.smtpHost ?? '') : '');
  const [smtpPort, setSmtpPort] = useState(stored?.preset === 'custom' ? String(stored.servers.smtpPort ?? '465') : '465');
  const [smtpTls, setSmtpTls] = useState<SmtpTls>(stored?.preset === 'custom' && stored.servers.smtpTls === 'starttls' ? 'starttls' : 'tls');
  const [problem, setProblem] = useState<string | null>(null);

  const custom = preset === 'custom';
  const info = custom ? null : PRESETS[preset];
  const hasConnector = Boolean(connector);

  const changeTls = (next: SmtpTls) => {
    setSmtpTls(next);
    // Keep the usual port for the mode unless the user typed their own.
    if (next === 'starttls' && smtpPort === '465') setSmtpPort('587');
    if (next === 'tls' && smtpPort === '587') setSmtpPort('465');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    const addr = address.trim();
    if (!addr.includes('@')) {
      setProblem('Enter the full email address, such as name@example.com.');
      return;
    }
    if (!hasConnector && password.trim() === '') {
      setProblem('Enter the app password.');
      return;
    }
    const body: ImapConnectorInput = { preset, address: addr };
    if (password.trim() !== '') body.appPassword = password.trim();
    if (custom) {
      const imapPortNumber = Number(imapPort);
      const smtpPortNumber = Number(smtpPort);
      if (imapHost.trim() === '' || smtpHost.trim() === '') {
        setProblem('Enter both the IMAP host and the SMTP host.');
        return;
      }
      const validPort = (value: number) => Number.isInteger(value) && value > 0 && value < 65536;
      if (!validPort(imapPortNumber) || !validPort(smtpPortNumber)) {
        setProblem('Ports are numbers from 1 to 65535.');
        return;
      }
      if (username.trim() !== '') body.username = username.trim();
      body.imapHost = imapHost.trim();
      body.imapPort = imapPortNumber;
      body.smtpHost = smtpHost.trim();
      body.smtpPort = smtpPortNumber;
      body.smtpTls = smtpTls;
    }
    setProblem(null);
    save.mutate(body, {
      onSuccess: (saved) => {
        setPassword('');
        if (saved.status !== 'error') onDone();
      },
    });
  };

  const serverValue = (preset: string, custom_: string) => (custom ? custom_ : preset);

  return (
    <form className="connector__form" onSubmit={submit}>
      <label className="connector__label" htmlFor="imap-preset">
        Provider
      </label>
      <select
        id="imap-preset"
        className="input"
        value={preset}
        disabled={save.isPending}
        onChange={(event) => {
          onPresetChange(event.target.value as ImapPreset);
          setProblem(null);
        }}
      >
        <option value="icloud">iCloud Mail</option>
        <option value="fastmail">Fastmail</option>
        <option value="custom">Custom</option>
      </select>

      <label className="connector__label" htmlFor="imap-address">
        Email address
      </label>
      <input
        id="imap-address"
        className="input"
        type="email"
        autoComplete="off"
        spellCheck={false}
        value={address}
        onChange={(event) => setAddress(event.target.value)}
      />

      {custom ? (
        <>
          <label className="connector__label" htmlFor="imap-username">
            Username
          </label>
          <input
            id="imap-username"
            className="input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Leave blank to use the email address"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </>
      ) : null}

      <fieldset className="connector__form" aria-describedby="imap-servers-note">
        <legend className="connector__label">Servers</legend>
        <div className="connector__row">
          <label className="sr-only" htmlFor="imap-imap-host">
            IMAP host
          </label>
          <input
            id="imap-imap-host"
            className="input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="imap.example.com"
            readOnly={!custom}
            value={serverValue(info?.imapHost ?? '', imapHost)}
            onChange={(event) => setImapHost(event.target.value)}
          />
          <label className="sr-only" htmlFor="imap-imap-port">
            IMAP port
          </label>
          <input
            id="imap-imap-port"
            className="input input--port num"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            readOnly={!custom}
            value={serverValue(info?.imapPort ?? '', imapPort)}
            onChange={(event) => setImapPort(event.target.value)}
          />
        </div>
        <div className="connector__row">
          <label className="sr-only" htmlFor="imap-smtp-host">
            SMTP host
          </label>
          <input
            id="imap-smtp-host"
            className="input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="smtp.example.com"
            readOnly={!custom}
            value={serverValue(info?.smtpHost ?? '', smtpHost)}
            onChange={(event) => setSmtpHost(event.target.value)}
          />
          <label className="sr-only" htmlFor="imap-smtp-port">
            SMTP port
          </label>
          <input
            id="imap-smtp-port"
            className="input input--port num"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            readOnly={!custom}
            value={serverValue(info?.smtpPort ?? '', smtpPort)}
            onChange={(event) => setSmtpPort(event.target.value)}
          />
          <label className="sr-only" htmlFor="imap-smtp-tls">
            SMTP security
          </label>
          <select
            id="imap-smtp-tls"
            className="input input--select"
            disabled={!custom}
            value={custom ? smtpTls : (info?.smtpTls ?? 'tls')}
            onChange={(event) => changeTls(event.target.value as SmtpTls)}
          >
            <option value="tls">TLS</option>
            <option value="starttls">STARTTLS</option>
          </select>
        </div>
        <p className="muted" id="imap-servers-note">
          {custom
            ? 'IMAP host and port on the first line, SMTP host, port, and security on the second.'
            : `Set by the ${info?.label} preset. Choose Custom to use other servers.`}
        </p>
      </fieldset>

      <PresetHint preset={preset} />

      <label className="connector__label" htmlFor="imap-password">
        {hasConnector ? 'New app password' : 'App password'}
      </label>
      <input
        id="imap-password"
        className="input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        aria-describedby="imap-password-note"
      />
      <p className="muted" id="imap-password-note">
        The app password is stored unencrypted in the local database file on this computer and is sent only to the mail
        servers above. Anyone who can read that file can read it.
        {hasConnector ? ' Leave it blank to keep the stored one.' : ''}
      </p>

      <div className="connector__row">
        <button type="submit" className="btn btn--primary" disabled={save.isPending}>
          {save.isPending ? 'Connecting...' : hasConnector ? 'Save and verify' : 'Connect'}
        </button>
        {hasConnector && connector?.status !== 'error' ? (
          <button type="button" className="btn btn--quiet" disabled={save.isPending} onClick={onDone}>
            Cancel
          </button>
        ) : null}
      </div>
      {save.isPending ? (
        <p className="muted" role="status">
          Checking the IMAP login, finding the Sent mailbox, then checking SMTP. This can take a few seconds.
        </p>
      ) : null}
      {problem ? (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      ) : null}
      {save.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(save.error)} Nothing was verified.
        </p>
      ) : null}
    </form>
  );
}

export function ImapConnectorCard() {
  const { query, connector } = useImapConnector();
  const active = useMailProvider().data ?? null;
  const remove = useRemoveImapConnector();
  const [editing, setEditing] = useState(false);
  const [open, toggle] = useCardOpen(connector);

  const imap = connector?.imap ?? null;
  const hasError = connector?.status === 'error';
  const ready = mailConnectorReady('imap', connector);
  const name = mailProviderName('imap', imap?.preset);
  // The preset picked in the form. The limits sentence below follows it while the form is showing.
  const [draftPreset, setDraftPreset] = useState<ImapPreset>(imap?.preset ?? 'icloud');
  const showForm = !connector || hasError || editing || !ready;
  const shownPreset: ImapPreset = showForm ? draftPreset : (imap?.preset ?? 'custom');

  const servers = imap?.servers;
  const serverLine = servers
    ? `IMAP ${servers.imapHost ?? 'unknown'}${servers.imapPort ? `:${servers.imapPort}` : ''}. SMTP ${servers.smtpHost ?? 'unknown'}${servers.smtpPort ? `:${servers.smtpPort}` : ''}, ${tlsLabel(servers.smtpTls)}.`
    : null;

  return (
    <article className="connector" aria-label="IMAP and SMTP connector">
      <CardToggle
        name="IMAP and SMTP"
        mark={CONNECTOR_MARKS.imap}
        markActive={active?.kind === 'imap'}
        summary={connector ? (connector.emailAddress ?? 'not verified') : null}
        state={mailCardState('imap', connector, active, connector && !ready ? { tone: 'off', label: 'Not verified' } : undefined)}
        open={open}
        onToggle={toggle}
        bodyId="imap-card-body"
      />
      {open ? (
        <div className="connector__body" id="imap-card-body">
          {query.isError ? (
            <p className="inline-error" role="alert">
              {errorMessage(query.error)} The IMAP and SMTP connection could not be checked.
            </p>
          ) : null}

          {connector && hasError && !editing ? (
            // The Sent mailbox stays changeable in the error state, so a wrong choice never locks the card.
            <SentMailboxControl connector={connector} />
          ) : null}
          {connector && !showForm ? (
            <>
              <p>
                Sending from <span className="cell-name">{connector.emailAddress}</span>
                {imap?.preset && imap.preset !== 'custom' ? <span className="muted"> with {name}</span> : null}
              </p>
              {serverLine ? <p className="muted">{serverLine}</p> : null}
              {checksLine(connector) ? <p className="muted">{checksLine(connector)}</p> : null}
              <SentMailboxControl connector={connector} />
              <p className="muted">
                {connector.lastSyncAt ? `Last synced ${formatAgo(connector.lastSyncAt)}.` : 'Not synced yet.'}
              </p>
              {connector.statusMessage ? (
                // A note on a connected account, such as the gap after the server reset its mailbox numbering.
                <p className="muted" role="status">
                  {connector.statusMessage}
                </p>
              ) : null}
              <UseMailProvider kind="imap" name={name} connector={connector} active={active} />
              <div className="connector__row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDraftPreset(imap?.preset ?? 'icloud');
                    setEditing(true);
                  }}
                >
                  Change account or app password
                </button>
              </div>
            </>
          ) : (
            <>
              {!connector ? (
                <p className="muted">
                  Connect an iCloud Mail, Fastmail, or other IMAP and SMTP account to send the drafts you approve and
                  to read replies. Each message is sent only after you approve its exact text. Agents cannot send.
                </p>
              ) : null}
              {hasError ? (
                <>
                  <p className="inline-error" role="alert">
                    {connector?.statusMessage ?? 'The last check of this account failed. Check the details and connect again.'}
                  </p>
                  {connector && checksLine(connector) ? <p className="muted">{checksLine(connector)}</p> : null}
                </>
              ) : connector && !ready ? (
                <p className="muted" role="status">
                  This account has not passed both checks yet, so it cannot send. {connector ? checksLine(connector) : ''}
                </p>
              ) : null}
              <ImapForm connector={connector} preset={draftPreset} onPresetChange={setDraftPreset} onDone={() => setEditing(false)} />
            </>
          )}

          <LimitsSentence preset={shownPreset} />
          <p className="muted">
            This app reads replies from the Inbox folder only, so a reply that a rule moves to another folder is not
            seen.
          </p>
          <p className="muted">
            Whether the server keeps its own copy of sent mail is not documented for these providers, so when a send is
            accepted this app tries to file a copy in the Sent mailbox itself; a copy that could not be saved is noted
            on the message.
          </p>

          {connector ? (
            <RemoveControl
              provider="IMAP and SMTP"
              mutation={{ isPending: remove.isPending, isError: remove.isError, error: remove.error, mutate: () => remove.mutate() }}
              warning="Remove IMAP and SMTP and delete the stored app password? Messages that are queued or approved to be sent with it will be blocked and will not send. Sent messages and replies already stored stay. To end the provider's side of the access, also delete the app password in your mail account."
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
