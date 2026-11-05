import { useState, type FormEvent } from 'react';
import { useCreatePerson } from '../api/hooks';
import type { Lifecycle } from '../api/types';
import { Sheet, errorMessage } from '../components/common';

const LIFECYCLE_OPTIONS: Array<{ value: Lifecycle; label: string }> = [
  { value: 'relationship', label: 'Relationship' },
  { value: 'lead', label: 'Lead' },
];

// Someone added by hand is usually known, so the choice starts on Relationship.
export function NewPersonSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const create = useCreatePerson();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [lifecycle, setLifecycle] = useState<Lifecycle>('relationship');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!firstName.trim()) {
      setProblem('Enter a first name.');
      return;
    }
    setProblem(null);
    try {
      const person = await create.mutateAsync({
        firstName: firstName.trim(),
        ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        lifecycle,
      });
      onCreated(person.id);
    } catch (error) {
      setProblem(`${errorMessage(error)} The person was not created.`);
    }
  };

  return (
    <Sheet title="New person" onClose={onClose}>
      <form className="connector__form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="field-label" htmlFor="new-person-first">
          First name
        </label>
        <input id="new-person-first" className="input" value={firstName} autoFocus onChange={(event) => setFirstName(event.target.value)} />
        <label className="field-label" htmlFor="new-person-last">
          Last name
        </label>
        <input id="new-person-last" className="input" value={lastName} onChange={(event) => setLastName(event.target.value)} />
        <label className="field-label" htmlFor="new-person-email">
          Email
        </label>
        <input id="new-person-email" className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        <label className="field-label" htmlFor="new-person-title">
          Title
        </label>
        <input id="new-person-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} />
        <label className="field-label" htmlFor="new-person-lifecycle">
          Lifecycle
        </label>
        <select
          id="new-person-lifecycle"
          className="input input--select"
          value={lifecycle}
          onChange={(event) => setLifecycle(event.target.value as Lifecycle)}
        >
          {LIFECYCLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {problem ? (
          <p className="muted" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="connector__row">
          <button type="submit" className="btn btn--primary" disabled={create.isPending}>
            {create.isPending ? 'Creating...' : 'Create person'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}
