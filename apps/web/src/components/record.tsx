import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useCreateNote } from '../api/hooks';
import { ApiError, isVersionConflict } from '../api/client';
import type { Activity, Claim, Opportunity } from '../api/types';
import { formatAge, formatAgo, formatAmount, formatDateTime, humanize } from '../lib/format';
import { Chip, ChipButton, errorMessage } from './common';
import { Icon } from './Icons';

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
          {humanize(claim.sourceType)}, <span className="num">{formatAge(claim.observedAt)}</span>
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
  children,
  claims,
  openClaim,
  onToggleClaim,
}: {
  label: string;
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

export function EditableValue({
  label,
  field,
  value,
  save,
  onReload,
}: {
  label: string;
  field: string;
  value: string | null;
  save: (value: string, versionOverride?: number) => Promise<void>;
  onReload: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

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
    setSaving(true);
    try {
      await save(next, versionOverride);
      setEditing(false);
      setProblem(null);
    } catch (error) {
      if (isVersionConflict(error)) {
        const current = (error.current ?? {}) as Record<string, unknown>;
        const currentValue = current[field];
        setProblem({
          kind: 'conflict',
          message: `${label} changed since you opened this record. ${
            typeof currentValue === 'string' && currentValue
              ? `It is now "${currentValue}".`
              : 'The current value is different from the one you saw.'
          } Your edit "${next}" was not saved.`,
          currentVersion: typeof current.version === 'number' ? current.version : undefined,
        });
      } else {
        setProblem({
          kind: 'error',
          message: `${error instanceof ApiError ? error.message : errorMessage(error)} Your edit was not saved.`,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    await onReload();
    setProblem(null);
    setEditing(false);
  };

  return (
    <div className="editable">
      {editing ? (
        <input
          className="input editable__input"
          value={draft}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          disabled={saving}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setEditing(false);
              setProblem(null);
            }
          }}
          onBlur={() => {
            if (!problem && !saving) void commit();
          }}
        />
      ) : (
        <>
          <span className={value ? '' : 'muted'}>{value || 'Not set'}</span>
          <button type="button" className="icon-btn icon-btn--small" onClick={begin} aria-label={`Edit ${label.toLowerCase()}`}>
            <Icon name="pencil" />
          </button>
        </>
      )}
      {problem ? (
        <div className="conflict" role="alert">
          <p>{problem.message}</p>
          <div className="conflict__actions">
            <button type="button" className="btn" onMouseDown={(event) => event.preventDefault()} onClick={() => void reload()}>
              Reload record
            </button>
            {problem.kind === 'conflict' && problem.currentVersion !== undefined ? (
              <button
                type="button"
                className="btn"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void commit(problem.currentVersion)}
              >
                Save my value over it
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const KIND_LABELS: Record<string, string> = {
  note: 'Note',
  email_draft: 'Email draft',
  stage_change: 'Stage change',
  agent: 'Agent',
};

export function Timeline({ activities }: { activities: Activity[] }) {
  if (activities.length === 0) {
    return <p className="muted">No activity yet. Notes, stage changes, and agent work appear here.</p>;
  }
  return (
    <ol className="timeline">
      {activities.map((activity) => (
        <li key={activity.id} className="timeline__item">
          <div className="timeline__head">
            <span className="timeline__kind">{KIND_LABELS[activity.kind] ?? humanize(activity.kind)}</span>
            {activity.kind === 'email_draft' ? <Chip tone="neutral">Demo draft</Chip> : null}
            <span className="muted num timeline__age" title={formatDateTime(activity.createdAt)}>
              {formatAge(activity.createdAt)}
            </span>
          </div>
          <p className="timeline__body">{activity.body}</p>
          <span className="muted">{activity.actor}</span>
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

export function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sheet-section">
      <h3 className="sheet-section__title">{title}</h3>
      {children}
    </section>
  );
}
