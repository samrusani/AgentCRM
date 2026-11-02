import { useState, type FormEvent } from 'react';
import { useAddSuppression, useSuppressions } from '../api/hooks';
import { EmptyState, ErrorState, Loading, errorMessage } from '../components/common';
import { LiftSuppressionControl } from '../components/liftSuppression';
import { formatDateTime } from '../lib/format';
import { isValidEmailAddress, suppressionReasonLabel } from '../lib/mail';

export function SuppressionSettings() {
  const query = useSuppressions();
  const add = useAddSuppression();
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!value || add.isPending) return;
    if (!isValidEmailAddress(value)) {
      setProblem('Enter a full email address such as name@company.com.');
      return;
    }
    setProblem(null);
    add.mutate(value, { onSuccess: () => setEmail('') });
  };

  const items = query.data ?? [];

  return (
    <section className="section" aria-labelledby="settings-suppressions">
      <h2 className="section__title" id="settings-suppressions">
        Suppressed addresses
      </h2>
      <p className="muted">
        Suppressed addresses are never emailed. Replies with opt out wording and bounces add addresses here on their
        own. Lifting a suppression is your decision and is recorded.
      </p>

      {query.isPending ? <Loading what="suppressions" /> : null}
      {query.isError ? (
        <ErrorState what="suppressions" error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.isSuccess && items.length === 0 ? (
        <EmptyState message="No addresses are suppressed. Opt outs, bounces, and addresses you add appear here." />
      ) : null}
      {items.length > 0 ? (
        <ul className="suppression-list" aria-label="Suppressed addresses">
          {items.map((item) => (
            <li key={item.id} className="suppression">
              <div className="suppression__main">
                <span className="cell-name suppression__email">{item.email}</span>
                <span className="muted">
                  {suppressionReasonLabel(item.reason)}
                  {item.createdAt ? <span className="num">, {formatDateTime(item.createdAt)}</span> : null}
                </span>
              </div>
              <LiftSuppressionControl suppressionId={item.id} email={item.email} />
            </li>
          ))}
        </ul>
      ) : null}

      <form className="connector__form suppression-add" onSubmit={submit}>
        <label className="connector__label" htmlFor="suppression-email">
          Add an address to suppress
        </label>
        <div className="connector__row">
          <input
            id="suppression-email"
            className="input"
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder="name@company.com"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setProblem(null);
            }}
          />
          <button type="submit" className="btn" disabled={add.isPending || email.trim() === ''}>
            {add.isPending ? 'Adding...' : 'Add suppression'}
          </button>
        </div>
        {problem ? (
          <p className="inline-error" role="alert">
            {problem}
          </p>
        ) : null}
        {add.isError ? (
          <p className="inline-error" role="alert">
            {errorMessage(add.error)} The address was not added.
          </p>
        ) : null}
      </form>
    </section>
  );
}
