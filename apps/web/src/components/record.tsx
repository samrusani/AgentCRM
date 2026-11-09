import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useCreateNote } from '../api/hooks';
import { ApiError, isVersionConflict } from '../api/client';
import type { Activity, Claim, Opportunity } from '../api/types';
import { domainHref, profileHref, profilePath, websiteHref, websiteLabel } from '../lib/links';
import { formatAge, formatAgo, formatAmount, formatDateTime, humanize } from '../lib/format';
import { Chip, ChipButton, errorMessage } from './common';
import { Icon } from './Icons';
import { PrepareToSend } from './prepareSend';

function camel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

export function claimsForField(claims: Claim[], field: string): Claim[] {
  return claims.filter((claim) => camel(claim.field) === field);
}

function claimTone(status: string): 'accent' | 'neutral' {
  return status === 'corroborated' || status === 'human_confirmed' ? 'accent' : 'neutral';
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function ProfileLink({ value }: { value: string }) {
  const href = profileHref(value);
  if (!href) return <span>{value}</span>;
  return (
    <a className="link" href={href} target="_blank" rel="noreferrer noopener" title={value}>
      {profilePath(value)}
    </a>
  );
}

export function WebsiteLink({ value }: { value: string }) {
  const href = websiteHref(value);
  if (!href) return <span>{value}</span>;
  return (
    <a className="link" href={href} target="_blank" rel="noreferrer noopener" title={value}>
      {websiteLabel(value)}
    </a>
  );
}

// The stored domain is the visible text. The server may store it with a scheme or a path, so the link is built from the host.
export function DomainLink({ value }: { value: string }) {
  const href = domainHref(value);
  if (!href) return <span>{value}</span>;
  return (
    <a className="link" href={href} target="_blank" rel="noreferrer noopener">
      {value}
    </a>
  );
}

export function ClaimDetail({ claim }: { claim: Claim }) {
  const link = safeUrl(claim.sourceUrl);
  return (
    <div className="claim-detail">
      <dl>
        <div>
          <dt>Value</dt>
          <dd>{claim.value ?? 'Empty'}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            {link ? (
              <a className="link" href={link} target="_blank" rel="noreferrer noopener">
                {claim.sourceUrl}
              </a>
            ) : (
              (claim.sourceUrl ?? `No URL recorded (${humanize(claim.sourceType)})`)
            )}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{humanize(claim.status)}</dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd className="num">{formatDateTime(claim.observedAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

export function EvidenceChips({
  claims,
  openId,
  onToggle,
}: {
  claims: Claim[];
  openId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <>
      {claims.map((claim) => (
        <ChipButton
          key={claim.id}
          tone={claimTone(claim.status)}
          pressed={openId === claim.id}
          title={`${humanize(claim.status)}. Click for source.`}
          onClick={() => onToggle(claim.id)}
          aria-label={`Evidence for ${humanize(claim.field)}: ${humanize(claim.sourceType)}, observed ${formatAgo(claim.observedAt)}, ${humanize(claim.status)}`}
        >
          {humanize(claim.sourceType)}, <span className="num chip__age">{formatAge(claim.observedAt)}</span>
        </ChipButton>
      ))}
    </>
  );
}

interface Problem {
  kind: 'conflict' | 'error';
  message: string;
  currentVersion?: number;
}

export function FieldRow({
  label,
  hint,
  children,
  claims,
  openClaim,
  onToggleClaim,
}: {
  label: string;
  // A muted line under the row, such as a custom attribute's description.
  hint?: string | null;
  children: ReactNode;
  claims?: Claim[];
  openClaim: string | null;
  onToggleClaim: (id: string) => void;
}) {
  const open = claims?.find((claim) => claim.id === openClaim);
  return (
    <div className="field">
      <dt className="field__label">{label}</dt>
      <dd className="field__value">
        <div className="field__main">{children}</div>
        {hint ? <p className="muted field__hint">{hint}</p> : null}
        {claims && claims.length > 0 ? (
          <div className="field__chips">
            <EvidenceChips claims={claims} openId={openClaim} onToggle={onToggleClaim} />
          </div>
        ) : null}
        {open ? <ClaimDetail claim={open} /> : null}
      </dd>
    </div>
  );
}

// The wording for a failed save, shared by every editable field: a conflict says what the field is now, any other
// failure says the edit was not saved.
function failureProblem(error: unknown, label: string, field: string, next: string): Problem {
  if (isVersionConflict(error)) {
    const current = (error.current ?? {}) as Record<string, unknown>;
    const currentValue = current[field];
    return {
      kind: 'conflict',
      message: `${label} changed since you opened this record. ${
        typeof currentValue === 'string' && currentValue
          ? `It is now "${currentValue}".`
          : 'The current value is different from the one you saw.'
      } Your edit "${next}" was not saved.`,
      currentVersion: typeof current.version === 'number' ? current.version : undefined,
    };
  }
  return {
    kind: 'error',
    message: `${error instanceof ApiError ? error.message : errorMessage(error)} Your edit was not saved.`,
  };
}

function ProblemAlert({
  problem,
  onReload,
  onSaveOver,
}: {
  problem: Problem;
  onReload: () => void;
  onSaveOver: (version: number) => void;
}) {
  return (
    <div className="conflict" role="alert">
      <p>{problem.message}</p>
      <div className="conflict__actions">
        <button type="button" className="btn" onMouseDown={(event) => event.preventDefault()} onClick={onReload}>
          Reload record
        </button>
        {problem.kind === 'conflict' && problem.currentVersion !== undefined ? (
          <button
            type="button"
            className="btn"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSaveOver(problem.currentVersion!)}
          >
            Save my value over it
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function EditableValue({
  label,
  field,
  value,
  save,
  onReload,
  renderValue,
  multiline,
  limit,
}: {
  label: string;
  field: string;
  value: string | null;
  save: (value: string, versionOverride?: number) => Promise<void>;
  onReload: () => Promise<unknown>;
  // Shows a saved value in another form, such as a link. The edit control stays the same.
  renderValue?: (value: string) => ReactNode;
  // Edits in a textarea: Enter adds a line, Control or Command with Enter saves, Escape cancels, leaving the field saves.
  multiline?: boolean;
  // A character bound, stated only once the draft goes over it. Saving waits until the draft fits.
  limit?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const overLimit = limit !== undefined && draft.trim().length > limit;

  const begin = () => {
    setDraft(value ?? '');
    setProblem(null);
    setEditing(true);
  };

  const commit = async (versionOverride?: number) => {
    const next = draft.trim();
    if (next === (value ?? '') && versionOverride === undefined) {
      setEditing(false);
      return;
    }
    if (limit !== undefined && next.length > limit) return;
    setSaving(true);
    try {
      await save(next, versionOverride);
      setEditing(false);
      setProblem(null);
    } catch (error) {
      setProblem(failureProblem(error, label, field, next));
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    await onReload();
    setProblem(null);
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
    setProblem(null);
  };

  const inputProps = {
    value: draft,
    autoFocus: true,
    onFocus: (event: { currentTarget: { select: () => void } }) => event.currentTarget.select(),
    disabled: saving,
    'aria-label': label,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: () => {
      if (!problem && !saving) void commit();
    },
  };

  return (
    <div className="editable">
      {editing ? (
        multiline ? (
          <textarea
            className="input editable__input editable__textarea"
            rows={4}
            {...inputProps}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void commit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancel();
              }
            }}
          />
        ) : (
          <input
            className="input editable__input"
            {...inputProps}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void commit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancel();
              }
            }}
          />
        )
      ) : (
        <>
          {value && renderValue ? (
            renderValue(value)
          ) : (
            <span className={`${value ? '' : 'muted'}${multiline ? ' editable__text' : ''}`.trim()}>{value || 'Not set'}</span>
          )}
          <button type="button" className="icon-btn icon-btn--small" onClick={begin} aria-label={`Edit ${label.toLowerCase()}`}>
            <Icon name="pencil" />
          </button>
        </>
      )}
      {editing && overLimit ? (
        <p className="muted editable__limit" role="status">
          {label} is limited to {limit} characters. This is {draft.trim().length}.
        </p>
      ) : null}
      {problem ? <ProblemAlert problem={problem} onReload={() => void reload()} onSaveOver={(version) => void commit(version)} /> : null}
    </div>
  );
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY'];
const MAX_AMOUNT = 1_000_000_000_000;

// A money field: an amount and a currency select, shown like the opportunity amount. Saving sends { amount, currency },
// clearing the amount sends null. Moving between the amount and the currency select does not save; leaving both does.
export function EditableMoney({
  label,
  field,
  amount,
  currency,
  save,
  onReload,
}: {
  label: string;
  field: string;
  amount: number | null;
  currency: string;
  save: (value: { amount: number; currency: string } | null, versionOverride?: number) => Promise<void>;
  onReload: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftCurrency, setDraftCurrency] = useState(currency);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [invalid, setInvalid] = useState(false);
  const options = CURRENCIES.includes(draftCurrency) ? CURRENCIES : [draftCurrency, ...CURRENCIES];

  const begin = () => {
    setDraft(amount === null ? '' : String(amount));
    setDraftCurrency(currency);
    setProblem(null);
    setInvalid(false);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setProblem(null);
    setInvalid(false);
  };

  const commit = async (versionOverride?: number) => {
    const text = draft.trim();
    const parsed = text === '' ? null : Number(text);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_AMOUNT)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (versionOverride === undefined && parsed === amount && (parsed === null || draftCurrency === currency)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await save(parsed === null ? null : { amount: parsed, currency: draftCurrency }, versionOverride);
      setEditing(false);
      setProblem(null);
    } catch (error) {
      setProblem(failureProblem(error, label, field, text));
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    await onReload();
    cancel();
  };

  return (
    <div className="editable">
      {editing ? (
        <div
          className="amount-row editable__input"
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            if (!problem && !saving) void commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
        >
          <input
            className="input input--number num"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            placeholder="Optional"
            value={draft}
            autoFocus
            disabled={saving}
            aria-label={label}
            aria-invalid={invalid}
            onChange={(event) => setDraft(event.target.value)}
          />
          <select
            className="input input--select"
            value={draftCurrency}
            disabled={saving}
            aria-label={`${label} currency`}
            onChange={(event) => setDraftCurrency(event.target.value)}
          >
            {options.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          {amount === null ? <span className="muted">Not set</span> : <span className="num">{formatAmount(amount, currency)}</span>}
          <button type="button" className="icon-btn icon-btn--small" onClick={begin} aria-label={`Edit ${label.toLowerCase()}`}>
            <Icon name="pencil" />
          </button>
        </>
      )}
      {editing && invalid ? (
        <p className="muted" role="alert">
          Enter the amount as a whole number, 0 or more.
        </p>
      ) : null}
      {problem ? <ProblemAlert problem={problem} onReload={() => void reload()} onSaveOver={(version) => void commit(version)} /> : null}
    </div>
  );
}

const KIND_LABELS: Record<string, string> = {
  note: 'Note',
  email_draft: 'Email draft',
  email_out: 'Sent (provider accepted)',
  email_in: 'Reply received',
  stage_change: 'Stage change',
  agent: 'Agent',
};

// Drafts can be prepared for sending only on a person, where the send review names the recipient.
export function Timeline({ activities, prepareSend = false }: { activities: Activity[]; prepareSend?: boolean }) {
  if (activities.length === 0) {
    return <p className="muted">No activity yet. Notes, stage changes, and agent work appear here.</p>;
  }
  return (
    <ol className="timeline">
      {activities.map((activity) => (
        <li key={activity.id} className="timeline__item">
          <div className="timeline__head">
            <span className="timeline__kind">{KIND_LABELS[activity.kind] ?? humanize(activity.kind)}</span>
            {activity.kind === 'email_draft' ? (
              <Chip tone="neutral">{/^demo draft/i.test(activity.body) ? 'Demo draft, not sent' : 'Draft, not sent'}</Chip>
            ) : null}

            <span className="muted num timeline__age" title={formatDateTime(activity.createdAt)}>
              {formatAge(activity.createdAt)}
            </span>
          </div>
          <p className="timeline__body">{activity.body}</p>
          <span className="muted">{activity.actor}</span>
          {activity.kind === 'email_draft' && prepareSend && !/^demo draft/i.test(activity.body) ? (
            <PrepareToSend label="Prepare to send" input={{ draftActivityIds: [activity.id] }} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function NoteForm({ entityType, entityId }: { entityType: string; entityId: string }) {
  const [body, setBody] = useState('');
  const create = useCreateNote();
  return (
    <form
      className="note-form"
      onSubmit={(event) => {
        event.preventDefault();
        const text = body.trim();
        if (!text) return;
        create.mutate({ entityType, entityId, body: text }, { onSuccess: () => setBody('') });
      }}
    >
      <label className="sr-only" htmlFor={`note-${entityId}`}>
        New note
      </label>
      <textarea
        id={`note-${entityId}`}
        className="input"
        rows={2}
        value={body}
        placeholder="Add a note"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="note-form__row">
        {create.isError ? <span className="inline-error">{errorMessage(create.error)}</span> : <span />}
        <button type="submit" className="btn" disabled={!body.trim() || create.isPending}>
          {create.isPending ? 'Saving note...' : 'Add note'}
        </button>
      </div>
    </form>
  );
}

export function OpportunityList({ opportunities }: { opportunities: Opportunity[] }) {
  if (opportunities.length === 0) return <p className="muted">No opportunities linked to this record.</p>;
  return (
    <ul className="plain-list">
      {opportunities.map((opportunity) => (
        <li key={opportunity.id} className="plain-list__row">
          <Link className="link" to={`/pipeline?opportunity=${opportunity.id}`}>
            {opportunity.name}
          </Link>
          <span className="muted num">{formatAmount(opportunity.amountTarget, opportunity.currency)}</span>
          {opportunity.status !== 'open' ? <Chip tone="neutral">{humanize(opportunity.status)}</Chip> : null}
        </li>
      ))}
    </ul>
  );
}

// Header items sit beside the title on the same row. A full width item wraps below it.
export function SheetSection({ title, children, headerItems }: { title: string; children: ReactNode; headerItems?: ReactNode }) {
  return (
    <section className="sheet-section">
      {headerItems ? (
        <div className="sheet-section__head">
          <h3 className="sheet-section__title">{title}</h3>
          {headerItems}
        </div>
      ) : (
        <h3 className="sheet-section__title">{title}</h3>
      )}
      {children}
    </section>
  );
}
