import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMeetings } from '../api/hooks';
import type { Meeting } from '../api/types';
import { EmptyState, ErrorState, Loading, PageHeader } from '../components/common';
import { formatDateTime } from '../lib/format';
import { attendeeLabel } from '../lib/meetings';
import { MeetingSheet, NewMeetingSheet } from './MeetingSheet';

const DAY_MS = 24 * 60 * 60 * 1000;
// Held meetings go back a year. The server lists oldest first, so a bounded window keeps the newest ones in reach.
const PAST_WINDOW_DAYS = 365;

function MeetingRow({ meeting, onOpen }: { meeting: Meeting; onOpen: (id: string) => void }) {
  return (
    <li className="task">
      <div className="task__text">
        <span className="task__title">
          <button type="button" className="link link--button" onClick={() => onOpen(meeting.id)}>
            {meeting.title}
          </button>
        </span>
        <span className="task__meta">
          {[attendeeLabel(meeting.attendeeCount), meeting.organizationName].filter(Boolean).join(' · ')}
        </span>
      </div>
      <span className="task__due num">{formatDateTime(meeting.startsAt)}</span>
    </li>
  );
}

export function Meetings() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('meeting');
  const [creating, setCreating] = useState(false);
  const [showPast, setShowPast] = useState(false);
  // Fixed for the life of the screen so the queries do not change key every render.
  const bounds = useMemo(() => {
    const now = Date.now();
    return { now: new Date(now).toISOString(), pastFrom: new Date(now - PAST_WINDOW_DAYS * DAY_MS).toISOString() };
  }, []);
  const upcoming = useMeetings({ from: bounds.now });
  // Fetched either way, so the empty state can tell "no meetings at all" from "none upcoming".
  // Descending, so the 500 row cap keeps the newest held meetings, not the oldest in the window.
  const past = useMeetings({ from: bounds.pastFrom, to: bounds.now, limit: 500, order: 'desc' });

  const open = useCallback(
    (id: string) => {
      const copy = new URLSearchParams(params);
      copy.set('meeting', id);
      setParams(copy);
    },
    [params, setParams],
  );
  const close = useCallback(() => {
    const copy = new URLSearchParams(params);
    copy.delete('meeting');
    setParams(copy, { replace: true });
  }, [params, setParams]);

  const upcomingItems = [...(upcoming.data ?? [])].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  // Newest first for held meetings. Only fetched when the toggle is on.
  const pastAll = [...(past.data ?? [])].sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  const pastItems = showPast ? pastAll : [];
  const nothing = upcoming.isSuccess && upcomingItems.length === 0 && past.isSuccess && pastAll.length === 0;
  const onlyPast = upcoming.isSuccess && upcomingItems.length === 0 && !showPast && pastAll.length > 0;

  return (
    <div className="screen">
      <PageHeader title="Meetings">
        <button type="button" className="btn btn--quiet" aria-pressed={showPast} onClick={() => setShowPast((value) => !value)}>
          {showPast ? 'Hide past' : 'Show past'}
        </button>
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          New meeting
        </button>
      </PageHeader>

      {upcoming.isPending ? <Loading what="meetings" /> : null}
      {upcoming.isError ? <ErrorState what="meetings" error={upcoming.error} onRetry={() => void upcoming.refetch()} /> : null}
      {onlyPast ? <p className="muted">Nothing is coming up. Show past to see held meetings.</p> : null}
      {nothing ? <EmptyState message="No meetings yet. Add one when you book a call." /> : null}
      {upcomingItems.length > 0 ? (
        <section aria-label="Upcoming meetings">
          <ul className="task-list">
            {upcomingItems.map((meeting) => (
              <MeetingRow key={meeting.id} meeting={meeting} onOpen={open} />
            ))}
          </ul>
        </section>
      ) : null}
      {showPast && past.isError ? <ErrorState what="past meetings" error={past.error} onRetry={() => void past.refetch()} /> : null}
      {showPast && pastItems.length > 0 ? (
        <section aria-labelledby="meetings-past">
          <h2 className="subsection__title" id="meetings-past">
            Past <span className="num muted">{pastItems.length}</span>
          </h2>
          <ul className="task-list">
            {pastItems.map((meeting) => (
              <MeetingRow key={meeting.id} meeting={meeting} onOpen={open} />
            ))}
          </ul>
        </section>
      ) : null}

      {creating ? (
        <NewMeetingSheet
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            open(id);
          }}
        />
      ) : null}
      {!creating && openId ? <MeetingSheet id={openId} onClose={close} /> : null}
    </div>
  );
}
