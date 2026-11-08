import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { isVersionConflict } from '../api/client';
import {
  useAddMeetingAttendee,
  useCreateMeeting,
  useDeleteMeeting,
  useMeeting,
  useRemoveMeetingAttendee,
  useUpdateMeeting,
} from '../api/hooks';
import type { MeetingDetail } from '../api/types';
import { RecordPicker, type PickedRecord } from '../components/RecordPicker';
import { Icon } from '../components/Icons';
import { ErrorState, Loading, Sheet, errorMessage } from '../components/common';
import { SheetSection } from '../components/record';
import { formatDateTime } from '../lib/format';
import { fromLocalInput, nextHourInput, toLocalInput } from '../lib/meetings';
import { DeletedRecord, isNotFound } from './RecordSheets';
import { TranscriptCaptureCard } from './TranscriptCaptureCard';

const MAX_TITLE = 200;
const MAX_LOCATION = 200;
export const MAX_NOTES = 10000;
const ORDER_MESSAGE = 'The end must be after the start.';

function endsBeforeStart(start: string, end: string): boolean {
  const startsAt = fromLocalInput(start);
  const endsAt = fromLocalInput(end);
  return startsAt !== null && endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt);
}

// Books a meeting with a title and a start. Everything else (organization, deal, attendees, notes) is set on the sheet
// that opens next, so the first step stays short.
export function NewMeetingSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const create = useCreateMeeting();
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(() => nextHourInput());
  const [end, setEnd] = useState('');
  const [location, setLocation] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const trimmed = title.trim();
  const startsAt = fromLocalInput(start);
  const orderProblem = endsBeforeStart(start, end);
  const ready = Boolean(trimmed) && startsAt !== null && !orderProblem && !create.isPending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || startsAt === null) return;
    setProblem(null);
    try {
      const meeting = await create.mutateAsync({
        title: trimmed,
        startsAt,
        endsAt: fromLocalInput(end),
        location: location.trim() === '' ? null : location.trim(),
      });
      onCreated(meeting.id);
    } catch (error) {
      setProblem(`${errorMessage(error)} The meeting was not created. Adjust the details and try again.`);
    }
  };

  return (
    <Sheet title="New meeting" onClose={onClose}>
      <form className="connector__form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="field-label" htmlFor="new-meeting-title">
          Title
        </label>
        <input
          id="new-meeting-title"
          className="input"
          value={title}
          autoFocus
          required
          maxLength={MAX_TITLE}
          aria-required="true"
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="field-label" htmlFor="new-meeting-start">
          Starts
        </label>
        <input
          id="new-meeting-start"
          className="input"
          type="datetime-local"
          value={start}
          required
          aria-required="true"
          onChange={(event) => setStart(event.target.value)}
        />
        <label className="field-label" htmlFor="new-meeting-end">
          Ends (optional)
        </label>
        <input
          id="new-meeting-end"
          className="input"
          type="datetime-local"
          value={end}
          aria-invalid={orderProblem || undefined}
          onChange={(event) => setEnd(event.target.value)}
        />
        {orderProblem ? (
          <p className="inline-error" role="alert">
            {ORDER_MESSAGE}
          </p>
        ) : null}
        <label className="field-label" htmlFor="new-meeting-location">
          Location (optional)
        </label>
        <input
          id="new-meeting-location"
          className="input"
          value={location}
          maxLength={MAX_LOCATION}
          onChange={(event) => setLocation(event.target.value)}
        />
        {problem ? (
          <p className="inline-error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="connector__row">
          <button type="submit" className="btn btn--primary" disabled={!ready}>
            {create.isPending ? 'Creating...' : 'Create meeting'}
          </button>
          <button type="button" className="btn btn--quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}

const conflictMessage = 'This meeting changed since you opened it. The latest version is loaded. Try again.';

export function MeetingSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const query = useMeeting(id);
  const meeting = query.data;
  return (
    <Sheet title={meeting?.title ?? 'Meeting'} subtitle={meeting ? formatDateTime(meeting.startsAt) : undefined} onClose={onClose}>
      {query.isPending ? <Loading what="meeting" /> : null}
      {query.isError && isNotFound(query.error) ? <DeletedRecord onClose={onClose} /> : null}
      {query.isError && !isNotFound(query.error) ? (
        <ErrorState what="this meeting" error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {meeting ? <MeetingBody meeting={meeting} onClose={onClose} onReload={() => void query.refetch()} /> : null}
    </Sheet>
  );
}

function MeetingBody({ meeting, onClose, onReload }: { meeting: MeetingDetail; onClose: () => void; onReload: () => void }) {
  const update = useUpdateMeeting();
  const [title, setTitle] = useState(meeting.title);
  const [start, setStart] = useState(toLocalInput(meeting.startsAt));
  const [end, setEnd] = useState(toLocalInput(meeting.endsAt));
  const [location, setLocation] = useState(meeting.location ?? '');
  const [detailsProblem, setDetailsProblem] = useState<string | null>(null);
  const [notes, setNotes] = useState(meeting.notes ?? '');
  const [notesProblem, setNotesProblem] = useState<string | null>(null);
  const [linkProblem, setLinkProblem] = useState<string | null>(null);

  // A newer version (a save of other fields, an event, a conflict reload) replaces the form fields that were not edited.
  // A field the person has typed in keeps their text.
  const [loaded, setLoaded] = useState(meeting);
  useEffect(() => {
    if (meeting.version === loaded.version) return;
    const refresh = <T,>(current: T, before: T, after: T): T => (current === before ? after : current);
    setTitle((current) => refresh(current, loaded.title, meeting.title));
    setStart((current) => refresh(current, toLocalInput(loaded.startsAt), toLocalInput(meeting.startsAt)));
    setEnd((current) => refresh(current, toLocalInput(loaded.endsAt), toLocalInput(meeting.endsAt)));
    setLocation((current) => refresh(current, loaded.location ?? '', meeting.location ?? ''));
    setNotes((current) => refresh(current, loaded.notes ?? '', meeting.notes ?? ''));
    setLoaded(meeting);
  }, [meeting, loaded]);

  const trimmedTitle = title.trim();
  const startsAt = fromLocalInput(start);
  const endsAt = fromLocalInput(end);
  const orderProblem = endsBeforeStart(start, end);
  const detailChanges: Record<string, unknown> = {};
  if (trimmedTitle !== meeting.title) detailChanges.title = trimmedTitle;
  // The inputs show minutes, so an untouched time compares as the input text and is never sent back with its seconds cut.
  if (startsAt !== null && start !== toLocalInput(meeting.startsAt)) detailChanges.startsAt = startsAt;
  if (end !== toLocalInput(meeting.endsAt)) detailChanges.endsAt = endsAt;
  const trimmedLocation = location.trim() === '' ? null : location.trim();
  if (trimmedLocation !== meeting.location) detailChanges.location = trimmedLocation;
  const canSaveDetails = Object.keys(detailChanges).length > 0 && Boolean(trimmedTitle) && startsAt !== null && !orderProblem && !update.isPending;

  const save = async (fields: Record<string, unknown>, onProblem: (message: string | null) => void, failure: string) => {
    onProblem(null);
    try {
      await update.mutateAsync({ id: meeting.id, expectedVersion: meeting.version, fields });
      return true;
    } catch (error) {
      onProblem(isVersionConflict(error) ? conflictMessage : `${errorMessage(error)} ${failure}`);
      if (isVersionConflict(error)) onReload();
      return false;
    }
  };

  const saveDetails = (event: FormEvent) => {
    event.preventDefault();
    if (!canSaveDetails) return;
    void save(detailChanges, setDetailsProblem, 'The details were not saved.');
  };

  const notesChanged = (notes.trim() === '' ? null : notes.trim()) !== meeting.notes;
  const saveNotes = () => {
    if (!notesChanged || update.isPending) return;
    void save({ notes: notes.trim() === '' ? null : notes }, setNotesProblem, 'The notes were not saved.');
  };

  const linkOrganization = (record: PickedRecord | null) => void save({ organizationId: record?.id ?? null }, setLinkProblem, 'The organization was not changed.');
  const linkDeal = (record: PickedRecord | null) => void save({ opportunityId: record?.id ?? null }, setLinkProblem, 'The deal was not changed.');

  return (
    <>
      <SheetSection title="Details">
        <form className="connector__form" onSubmit={saveDetails} noValidate>
          <label className="field-label" htmlFor="meeting-title">
            Title
          </label>
          <input
            id="meeting-title"
            className="input"
            value={title}
            maxLength={MAX_TITLE}
            required
            aria-required="true"
            onChange={(event) => setTitle(event.target.value)}
          />
          <label className="field-label" htmlFor="meeting-start">
            Starts
          </label>
          <input id="meeting-start" className="input" type="datetime-local" value={start} required aria-required="true" onChange={(event) => setStart(event.target.value)} />
          <label className="field-label" htmlFor="meeting-end">
            Ends
          </label>
          <input
            id="meeting-end"
            className="input"
            type="datetime-local"
            value={end}
            aria-invalid={orderProblem || undefined}
            onChange={(event) => setEnd(event.target.value)}
          />
          {orderProblem ? (
            <p className="inline-error" role="alert">
              {ORDER_MESSAGE}
            </p>
          ) : null}
          <label className="field-label" htmlFor="meeting-location">
            Location
          </label>
          <input id="meeting-location" className="input" value={location} maxLength={MAX_LOCATION} onChange={(event) => setLocation(event.target.value)} />
          {detailsProblem ? (
            <p className="inline-error" role="alert">
              {detailsProblem}
            </p>
          ) : null}
          <div className="connector__row">
            <button type="submit" className="btn btn--primary" disabled={!canSaveDetails}>
              {update.isPending ? 'Saving...' : 'Save details'}
            </button>
          </div>
        </form>
        <RecordPicker kind="organization" label="Organization" value={meeting.organizationId ? { id: meeting.organizationId, name: meeting.organizationName ?? 'Organization' } : null} onChange={linkOrganization} />
        <RecordPicker kind="opportunity" label="Deal" value={meeting.opportunityId ? { id: meeting.opportunityId, name: meeting.opportunityName ?? 'Deal' } : null} onChange={linkDeal} />
        {linkProblem ? (
          <p className="inline-error" role="alert">
            {linkProblem}
          </p>
        ) : null}
      </SheetSection>

      <AttendeesSection meeting={meeting} />

      <SheetSection title="Notes">
        <label className="sr-only" htmlFor="meeting-notes">
          Notes
        </label>
        <textarea
          id="meeting-notes"
          className="input"
          rows={6}
          maxLength={MAX_NOTES}
          value={notes}
          aria-describedby="meeting-notes-count"
          onChange={(event) => setNotes(event.target.value)}
        />
        <p className="muted num" id="meeting-notes-count">
          {notes.length.toLocaleString('en-US')} of {MAX_NOTES.toLocaleString('en-US')} characters
        </p>
        {notesProblem ? (
          <p className="inline-error" role="alert">
            {notesProblem}
          </p>
        ) : null}
        <div className="connector__row">
          <button type="button" className="btn btn--primary" disabled={!notesChanged || update.isPending} onClick={saveNotes}>
            Save notes
          </button>
        </div>
      </SheetSection>

      <TranscriptSection meeting={meeting} />

      <DeleteSection meeting={meeting} onDeleted={onClose} />
    </>
  );
}

function AttendeesSection({ meeting }: { meeting: MeetingDetail }) {
  const add = useAddMeetingAttendee();
  const remove = useRemoveMeetingAttendee();
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = (record: PickedRecord | null) => {
    if (!record) return;
    setProblem(null);
    setAdding(false);
    add.mutate(
      { meetingId: meeting.id, personId: record.id },
      { onError: (error) => setProblem(`${errorMessage(error)} ${record.name} was not added. Try again.`) },
    );
  };

  const drop = (personId: string, name: string) => {
    setProblem(null);
    remove.mutate(
      { meetingId: meeting.id, personId },
      { onError: (error) => setProblem(`${errorMessage(error)} ${name} is still an attendee. Try again.`) },
    );
  };

  return (
    <SheetSection title="Attendees">
      {meeting.attendees.length > 0 ? (
        <ul className="chip-list" aria-label="Attendees">
          {meeting.attendees.map((attendee) => (
            <li key={attendee.id}>
              <span className="chip chip--neutral chip--removable">
                {attendee.name}
                <button
                  type="button"
                  className="chip__remove"
                  aria-label={`Remove ${attendee.name}`}
                  disabled={remove.isPending}
                  onClick={() => drop(attendee.id, attendee.name)}
                >
                  <Icon name="close" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="muted">No attendees yet.</span>
      )}
      {adding ? (
        <div className="stack">
          <RecordPicker kind="person" label="Add attendee" value={null} onChange={pick} autoFocus />
          <div>
            <button type="button" className="btn btn--quiet" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button type="button" className="btn btn--quiet" onClick={() => setAdding(true)}>
            Add attendee
          </button>
        </div>
      )}
      {problem ? (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      ) : null}
    </SheetSection>
  );
}

function TranscriptSection({ meeting }: { meeting: MeetingDetail }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <SheetSection title="Call transcript">
      {open ? (
        <>
          <TranscriptCaptureCard
            meeting={{ id: meeting.id, title: meeting.title }}
            onStarted={(run) => navigate(`/research?run=${encodeURIComponent(run.id)}`)}
          />
          <div>
            <button type="button" className="btn btn--quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div>
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Capture transcript
          </button>
        </div>
      )}
    </SheetSection>
  );
}

function DeleteSection({ meeting, onDeleted }: { meeting: MeetingDetail; onDeleted: () => void }) {
  const remove = useDeleteMeeting();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const confirm = () => {
    setProblem(null);
    remove.mutate(meeting.id, {
      onSuccess: onDeleted,
      onError: (error) => setProblem(`${errorMessage(error)} The meeting was not deleted. Try again.`),
    });
  };

  return (
    <SheetSection title="Delete">
      {confirming ? (
        <span className="lift__confirm" role="alert">
          Deletes this meeting and its attendee links. People and their records stay. This cannot be undone.
          <button type="button" className="btn btn--danger" disabled={remove.isPending} onClick={confirm}>
            {remove.isPending ? 'Deleting...' : 'Delete meeting'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={remove.isPending}
            onClick={() => {
              setConfirming(false);
              setProblem(null);
            }}
          >
            Keep meeting
          </button>
        </span>
      ) : (
        <div>
          <button type="button" className="btn btn--quiet" onClick={() => setConfirming(true)}>
            Delete meeting
          </button>
        </div>
      )}
      {problem ? (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      ) : null}
    </SheetSection>
  );
}
