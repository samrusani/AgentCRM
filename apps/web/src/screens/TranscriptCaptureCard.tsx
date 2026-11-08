import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useModelProvider, useStartTranscriptCapture } from '../api/hooks';
import type { Run } from '../api/types';
import { errorMessage } from '../components/common';
import { MAX_TRANSCRIPT_LENGTH, TRANSCRIPT_COUNT_WINDOW } from '../lib/leads';

const MAX_TITLE_LENGTH = 200;

function formatCharacters(count: number): string {
  return count.toLocaleString('en-US');
}

// The Research entry for call transcripts: paste the text and a model reads out the people and organizations it
// names. The server validates every field again.
export function TranscriptCaptureCard({
  onStarted,
  meeting,
}: {
  onStarted: (run: Run) => void;
  // Set when the capture is opened from a meeting: the call name starts as the meeting title and the people the review
  // accepts join the meeting's attendees.
  meeting?: { id: string; title: string };
}) {
  const start = useStartTranscriptCapture();
  const provider = useModelProvider();
  const [text, setText] = useState('');
  const [textCut, setTextCut] = useState(false);
  const [title, setTitle] = useState(meeting?.title ?? '');

  const providerReady = provider.data?.ready === true;
  const hasText = text.trim() !== '';
  const showCount = text.trim().length >= MAX_TRANSCRIPT_LENGTH - TRANSCRIPT_COUNT_WINDOW;

  // The server trims before it counts, so the limit is measured on the trimmed text and the whitespace the person typed
  // stays. A cut never splits a surrogate pair: when it would land inside one, it goes one code unit earlier.
  const changeText = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > MAX_TRANSCRIPT_LENGTH) {
      const begin = value.length - value.trimStart().length;
      let end = begin + MAX_TRANSCRIPT_LENGTH;
      const last = value.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      setText(value.slice(0, end));
      setTextCut(true);
    } else {
      setText(value);
      setTextCut(false);
    }
  };

  const reason: ReactNode = !hasText && providerReady ? 'Paste the call transcript to stage people.' : null;
  const canStart = providerReady && hasText && !start.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canStart) return;
    const name = title.trim();
    start.mutate(
      { transcriptText: text, ...(name !== '' ? { title: name } : {}), ...(meeting ? { meetingId: meeting.id } : {}) },
      { onSuccess: onStarted },
    );
  };

  const providerLine = provider.isError ? (
    <p className="muted" id="transcript-capture-provider">
      Could not check the model provider.
    </p>
  ) : !provider.isPending && !providerReady ? (
    <p className="muted" id="transcript-capture-provider">
      Connect a model provider in{' '}
      <Link className="link" to="/settings/models">
        Settings
      </Link>{' '}
      first.
    </p>
  ) : null;

  return (
    <section className="lead-capture" aria-labelledby="transcript-capture-title">
      <h2 className="lead-capture__title" id="transcript-capture-title">
        From a call transcript
      </h2>
      <form className="connector__form" onSubmit={submit} noValidate>
        <label className="sr-only" htmlFor="transcript-capture-text">
          Call transcript
        </label>
        <textarea
          id="transcript-capture-text"
          className="input"
          rows={6}
          spellCheck={false}
          placeholder="Paste the call transcript"
          value={text}
          aria-describedby="transcript-capture-text-note"
          onChange={(event) => changeText(event.target.value)}
        />
        <p className="muted" id="transcript-capture-text-note">
          Up to {formatCharacters(MAX_TRANSCRIPT_LENGTH)} characters.
          {textCut
            ? ` The text was longer, so the first ${formatCharacters(MAX_TRANSCRIPT_LENGTH)} were kept.`
            : showCount
              ? ` ${formatCharacters(text.trim().length)} used.`
              : ''}
        </p>
        <div className="lead-capture__field">
          <label className="connector__label" htmlFor="transcript-capture-name">
            Call name (optional)
          </label>
          <input
            id="transcript-capture-name"
            className="input"
            type="text"
            autoComplete="off"
            maxLength={MAX_TITLE_LENGTH}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        {providerLine}
        <div>
          <button type="submit" className="btn btn--primary" disabled={!canStart}>
            {start.isPending ? 'Starting...' : 'Stage people for review'}
          </button>
        </div>
        <p className={reason ? 'muted' : 'sr-only'} id="transcript-capture-reason" aria-live="polite">
          {reason}
        </p>
        {start.isError ? (
          <p className="inline-error" role="alert">
            Could not start the capture. {errorMessage(start.error)}
          </p>
        ) : null}
      </form>
      <p className="muted lead-capture__note">
        Reading the transcript uses your active model provider and spends model usage; costs shown are estimates. Every
        row waits for your review before anything is saved.
        {meeting ? ' The people you accept join this meeting as attendees.' : ''}
      </p>
    </section>
  );
}
