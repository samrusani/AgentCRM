import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQualification, useSaveQualification } from '../api/hooks';
import type {
  Criterion,
  CriterionField,
  CriterionOperator,
  CriterionTarget,
  QualificationConfig,
} from '../api/types';
import { ErrorState, Loading, errorMessage } from '../components/common';
import { Icon } from '../components/Icons';
import { QualifyRunAction } from '../components/qualification';

const TARGETS: Array<{ value: CriterionTarget; label: string }> = [
  { value: 'person', label: 'Person' },
  { value: 'organization', label: 'Organization' },
];

const OPERATORS: Array<{ value: CriterionOperator; label: string }> = [
  { value: 'contains', label: 'Contains' },
  { value: 'equals', label: 'Equals' },
  { value: 'in', label: 'Is one of' },
  { value: 'exists', label: 'Has a value' },
];

const FIELD_LABELS: Record<CriterionField, string> = {
  title: 'Title',
  location: 'Location',
  tags: 'Tags',
  email: 'Email',
  name: 'Name',
  kind: 'Kind',
  domain: 'Domain',
};

const FIELDS_BY_TARGET: Record<CriterionTarget, CriterionField[]> = {
  person: ['title', 'location', 'tags', 'email', 'name'],
  organization: ['kind', 'domain', 'location', 'tags', 'name'],
};

function newId(): string {
  return `crt_${Math.random().toString(36).slice(2, 10)}`;
}

function blankRule(field: CriterionField): Criterion {
  return { id: newId(), label: '', target: 'person', field, operator: 'contains', values: [], enabled: true };
}

function cleanRule(rule: Criterion): Criterion {
  return {
    ...rule,
    label: rule.label.trim(),
    values: rule.operator === 'exists' ? [] : rule.values,
  };
}

function ruleProblem(rule: Criterion): string | null {
  if (rule.label.trim() === '') return 'Add a label so results can name this rule.';
  if (rule.operator !== 'exists' && rule.values.length === 0) return 'Add at least one value, or choose "Has a value".';
  return null;
}

function ruleName(rule: Criterion): string {
  return rule.label.trim() || 'this rule';
}

function ValueChips({
  rule,
  idBase,
  onChange,
}: {
  rule: Criterion;
  idBase: string;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  const add = (event: FormEvent) => {
    event.preventDefault();
    const incoming = draft
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (incoming.length === 0) return;
    const next = [...rule.values];
    for (const value of incoming) {
      if (!next.some((existing) => existing.toLowerCase() === value.toLowerCase())) next.push(value);
    }
    onChange(next);
    setDraft('');
  };

  if (rule.operator === 'exists') {
    return <p className="muted">This rule checks that the field has a value, so it needs no values.</p>;
  }

  return (
    <div className="qual-values">
      {rule.values.length > 0 ? (
        <ul className="chip-list" aria-label={`Values for ${ruleName(rule)}`}>
          {rule.values.map((value) => (
            <li key={value}>
              <span className="chip chip--neutral chip--removable">
                {value}
                <button
                  type="button"
                  className="chip__remove"
                  aria-label={`Remove value ${value} from ${ruleName(rule)}`}
                  onClick={() => onChange(rule.values.filter((entry) => entry !== value))}
                >
                  <Icon name="close" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="connector__row" onSubmit={add}>
        <label className="sr-only" htmlFor={`${idBase}-value`}>
          Add a value to {ruleName(rule)}
        </label>
        <input
          id={`${idBase}-value`}
          className="input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Add a value, separate several with commas"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn" disabled={draft.trim() === ''} aria-label={`Add value to ${ruleName(rule)}`}>
          Add value
        </button>
      </form>
    </div>
  );
}

function RuleEditor({
  rule,
  idBase,
  problem,
  onChange,
  onRemove,
}: {
  rule: Criterion;
  idBase: string;
  problem: string | null;
  onChange: (next: Criterion) => void;
  onRemove: () => void;
}) {
  const fieldChoices = FIELDS_BY_TARGET[rule.target].includes(rule.field)
    ? FIELDS_BY_TARGET[rule.target]
    : [...FIELDS_BY_TARGET[rule.target], rule.field];

  const changeTarget = (target: CriterionTarget) => {
    const allowed = FIELDS_BY_TARGET[target];
    onChange({ ...rule, target, field: allowed.includes(rule.field) ? rule.field : allowed[0] });
  };

  return (
    <li className="qual-row" aria-label={`Rule: ${ruleName(rule)}`}>
      <div className="qual-row__top">
        <label className="toggle">
          <input
            type="checkbox"
            aria-label={`Enabled for ${ruleName(rule)}`}
            checked={rule.enabled}
            onChange={(event) => onChange({ ...rule, enabled: event.target.checked })}
          />
          <span>Enabled</span>
        </label>
        <label className="sr-only" htmlFor={`${idBase}-label`}>
          Label
        </label>
        <input
          id={`${idBase}-label`}
          className="input"
          type="text"
          autoComplete="off"
          placeholder="Label, for example Title is partner"
          value={rule.label}
          aria-invalid={problem !== null && rule.label.trim() === ''}
          onChange={(event) => onChange({ ...rule, label: event.target.value })}
        />
        <button type="button" className="btn btn--quiet" onClick={onRemove} aria-label={`Remove ${rule.label.trim() || 'this rule'}`}>
          Remove
        </button>
      </div>
      <div className="qual-row__selects">
        <select
          className="input input--select"
          aria-label={`Target for ${ruleName(rule)}`}
          value={rule.target}
          onChange={(event) => changeTarget(event.target.value as CriterionTarget)}
        >
          {TARGETS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="input input--select"
          aria-label={`Field for ${ruleName(rule)}`}
          value={rule.field}
          onChange={(event) => onChange({ ...rule, field: event.target.value as CriterionField })}
        >
          {fieldChoices.map((field) => (
            <option key={field} value={field}>
              {FIELD_LABELS[field] ?? field}
            </option>
          ))}
        </select>
        <select
          className="input input--select"
          aria-label={`Operator for ${ruleName(rule)}`}
          value={rule.operator}
          onChange={(event) => onChange({ ...rule, operator: event.target.value as CriterionOperator })}
        >
          {OPERATORS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <ValueChips rule={rule} idBase={idBase} onChange={(values) => onChange({ ...rule, values })} />
      {problem ? (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      ) : null}
    </li>
  );
}

function RuleList({
  heading,
  headingId,
  description,
  rules,
  emptyText,
  addLabel,
  showProblems,
  onChange,
  onAdd,
}: {
  heading: string;
  headingId: string;
  description: string;
  rules: Criterion[];
  emptyText: string;
  addLabel: string;
  showProblems: boolean;
  onChange: (rules: Criterion[]) => void;
  onAdd: () => void;
}) {
  return (
    <div className="qual-group">
      <h3 className="connector__heading" id={headingId}>
        {heading}
      </h3>
      <p className="muted">{description}</p>
      {rules.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <ul className="qual-list" aria-labelledby={headingId}>
          {rules.map((rule, index) => (
            <RuleEditor
              key={rule.id}
              rule={rule}
              idBase={`${headingId}-${rule.id}`}
              problem={showProblems ? ruleProblem(rule) : null}
              onChange={(next) => onChange(rules.map((entry, position) => (position === index ? next : entry)))}
              onRemove={() => onChange(rules.filter((_entry, position) => position !== index))}
            />
          ))}
        </ul>
      )}
      <div>
        <button type="button" className="btn" onClick={onAdd}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}

function QualificationForm({ saved }: { saved: QualificationConfig }) {
  const save = useSaveQualification();
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<QualificationConfig>(saved);
  const [showProblems, setShowProblems] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const baseline = useRef(savedKey);

  // Adopt a newer server copy only when nothing here has been edited.
  useEffect(() => {
    if (savedKey === baseline.current) return;
    if (JSON.stringify(draft) === baseline.current) setDraft(saved);
    baseline.current = savedKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const dirty = JSON.stringify(draft) !== savedKey;
  const hasProblems = [...draft.exclusions, ...draft.criteria].some((rule) => ruleProblem(rule) !== null);

  const edit = (next: QualificationConfig) => {
    setDraft(next);
    setSavedNote(false);
    save.reset();
  };

  const submit = () => {
    if (hasProblems) {
      setShowProblems(true);
      return;
    }
    setShowProblems(false);
    save.mutate(
      { exclusions: draft.exclusions.map(cleanRule), criteria: draft.criteria.map(cleanRule) },
      {
        onSuccess: (result) => {
          setDraft(result);
          baseline.current = JSON.stringify(result);
          setSavedNote(true);
        },
      },
    );
  };

  return (
    <div className="qual-form">
      {saved.defaulted ? (
        <p className="muted">These are the template defaults. They apply until you save your own.</p>
      ) : null}
      <p className="muted">
        A missing value is unknown, and unknown never counts as a match. Contains matches substrings.
      </p>

      <RuleList
        heading="Exclusions"
        headingId="qual-exclusions"
        description="A person who matches any enabled exclusion is marked excluded. Criteria are still computed for them."
        rules={draft.exclusions}
        emptyText="No exclusions. Nobody is excluded from qualification."
        addLabel="Add exclusion"
        showProblems={showProblems}
        onChange={(exclusions) => edit({ ...draft, exclusions })}
        onAdd={() => edit({ ...draft, exclusions: [...draft.exclusions, blankRule('tags')] })}
      />

      <RuleList
        heading="Criteria"
        headingId="qual-criteria"
        description="Each enabled criterion is checked for every person. Fit is the number matched out of the number enabled."
        rules={draft.criteria}
        emptyText="No criteria. People cannot be qualified until you add one."
        addLabel="Add criterion"
        showProblems={showProblems}
        onChange={(criteria) => edit({ ...draft, criteria })}
        onAdd={() => edit({ ...draft, criteria: [...draft.criteria, blankRule('title')] })}
      />

      {showProblems && hasProblems ? (
        <p className="inline-error" role="alert">
          Some rules are incomplete. Fix the rules marked above, then save.
        </p>
      ) : null}
      {save.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(save.error)} The saved configuration did not change.
        </p>
      ) : null}
      {savedNote && !dirty ? (
        <p className="muted" role="status">
          Saved. The new rules apply the next time qualification runs.
        </p>
      ) : null}

      <div className="qual-actions">
        <button type="button" className="btn btn--primary" onClick={submit} disabled={(!dirty && !saved.defaulted) || save.isPending}>
          {save.isPending ? 'Saving...' : 'Save qualification rules'}
        </button>
        {dirty ? (
          <button type="button" className="btn" onClick={() => edit(saved)} disabled={save.isPending}>
            Discard changes
          </button>
        ) : null}
      </div>

      <QualifyRunAction
        variant="settings"
        note={dirty ? 'A run uses the saved rules. Save your changes first.' : 'Recomputes results for every person.'}
      />
    </div>
  );
}

export function QualificationSettings() {
  const query = useQualification();
  return (
    <section className="section" aria-labelledby="settings-qualification">
      <h2 className="section__title" id="settings-qualification">
        Qualification
      </h2>
      {query.isPending ? <Loading what="qualification rules" /> : null}
      {query.isError ? (
        <ErrorState what="qualification rules" error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data ? <QualificationForm saved={query.data} /> : null}
    </section>
  );
}
