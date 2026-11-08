import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Approval } from '../../src/api/types';
import { ImportReviewBody } from '../../src/components/importReview';
import { MAX_TRANSCRIPT_LENGTH } from '../../src/lib/leads';
import { parseImportReviewPayload } from '../../src/lib/imports';
import { ImportBatchSheet } from '../../src/screens/ImportSheets';
import { TranscriptCaptureCard } from '../../src/screens/TranscriptCaptureCard';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({
    theme: 'system',
    setTheme: () => {},
    navCollapsed: false,
    setNavCollapsed: () => {},
    navNarrow: false,
    setSelectedRecord: () => {},
    setPaletteOpen: () => {},
    panelCollapsed: true,
    setPanelCollapsed: () => {},
    panelSheetOpen: false,
    setPanelSheetOpen: () => {},
    toasts: [],
    dismissToast: () => {},
    pushToast: () => {},
  }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));

interface Call {
  method: string;
  path: string;
  body: Record<string, any> | undefined;
}

let provider: 'ready' | 'none' | 'check-failed';
let calls: Call[];
let started: unknown[];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/model-provider' && method === 'GET') {
        if (provider === 'check-failed') return json(500, { error: { code: 'internal', message: 'Down.' } });
        return json(200, provider === 'ready' ? { kind: 'anthropic', model: 'claude-opus-5-5', status: 'connected', ready: true } : {});
      }
      if (url.pathname === '/api/imports/transcript' && method === 'POST') {
        return json(201, { id: 'run_tr', kind: 'transcript_capture', title: body?.title ?? 'Call transcript capture', status: 'queued', scope: {}, counts: {}, steps: [] });
      }
      if (url.pathname === '/api/imports/imp_tr') {
        return json(200, {
          id: 'imp_tr',
          runId: 'run_tr',
          sourceKind: 'transcript',
          sourceRef: { transcript: true },
          status: 'awaiting_review',
          counts: { fetched: 1, staged: 1, duplicates: 0, invalid: 0 },
          items: [
            {
              seq: 1,
              status: 'staged',
              mapped: { name: 'Tomas Reyes', company: 'Fenwick Capital', title: 'Partner' },
              raw: { quote: 'Tomas Reyes at Fenwick Capital suggested we talk.', extracted: true },
            },
          ],
          nextCursor: null,
        });
      }
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

function renderCard() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <TranscriptCaptureCard onStarted={(run) => started.push(run)} />
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

const submitButton = () => screen.getByRole('button', { name: 'Stage people for review' });
const textBox = () => screen.getByPlaceholderText('Paste the call transcript');
const startCalls = () => calls.filter((call) => call.method === 'POST' && call.path === '/api/imports/transcript');

async function ready() {
  const rendered = renderCard();
  await waitFor(() => expect(calls.some((call) => call.path === '/api/model-provider')).toBe(true));
  return rendered;
}

beforeEach(() => {
  provider = 'ready';
  calls = [];
  started = [];
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('transcript capture card', () => {
  it('renders the title, the fields, and the cost sentence', async () => {
    await ready();
    expect(screen.getByRole('heading', { name: 'From a call transcript' })).toBeInTheDocument();
    expect(textBox()).toBeInTheDocument();
    expect(screen.getByLabelText('Call name (optional)')).toBeInTheDocument();
    expect(screen.getByText('Up to 60,000 characters.')).toBeInTheDocument();
    expect(screen.getByText(/spends model usage; costs shown are estimates/)).toBeInTheDocument();
    expect(screen.getByText(/Every row waits for your review/)).toBeInTheDocument();
  });

  it('disables the button with a reason line while the text is empty', async () => {
    await ready();
    await waitFor(() => expect(screen.getByText('Paste the call transcript to stage people.')).toBeInTheDocument());
    expect(submitButton()).toBeDisabled();
    fireEvent.change(textBox(), { target: { value: '   ' } });
    expect(submitButton()).toBeDisabled();
    fireEvent.change(textBox(), { target: { value: 'Tomas Reyes joined.' } });
    expect(submitButton()).toBeEnabled();
  });

  it('disables the button and links to the model settings when no provider is ready', async () => {
    provider = 'none';
    await ready();
    fireEvent.change(textBox(), { target: { value: 'Tomas Reyes joined.' } });
    expect(await screen.findByText(/Connect a model provider in/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/models');
    expect(submitButton()).toBeDisabled();
  });

  it('says the provider could not be checked when the check fails', async () => {
    provider = 'check-failed';
    await ready();
    fireEvent.change(textBox(), { target: { value: 'Tomas Reyes joined.' } });
    expect(await screen.findByText('Could not check the model provider.')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('shows the live count only within 2,000 characters of the limit', async () => {
    await ready();
    fireEvent.change(textBox(), { target: { value: 'x'.repeat(MAX_TRANSCRIPT_LENGTH - 2001) } });
    expect(screen.getByText('Up to 60,000 characters.')).toBeInTheDocument();
    fireEvent.change(textBox(), { target: { value: 'x'.repeat(MAX_TRANSCRIPT_LENGTH - 2000) } });
    expect(screen.getByText('Up to 60,000 characters. 58,000 used.')).toBeInTheDocument();
  });

  it('keeps the first 60,000 characters of a longer paste, never splits a character, and says so', async () => {
    await ready();
    const longer = `${'x'.repeat(MAX_TRANSCRIPT_LENGTH - 1)}\u{1F600}tail`;
    fireEvent.change(textBox(), { target: { value: longer } });
    const kept = (textBox() as HTMLTextAreaElement).value;
    expect(kept).toBe('x'.repeat(MAX_TRANSCRIPT_LENGTH - 1));
    expect(screen.getByText(/The text was longer, so the first 60,000 were kept\./)).toBeInTheDocument();
  });

  it('posts the transcript, with the call name when one is typed, and hands the run to onStarted', async () => {
    const { user } = await ready();
    fireEvent.change(textBox(), { target: { value: 'Tomas Reyes at Fenwick Capital joined.' } });
    await user.type(screen.getByLabelText('Call name (optional)'), '  Seed call  ');
    await user.click(submitButton());
    await waitFor(() => expect(started).toHaveLength(1));
    expect(startCalls()).toHaveLength(1);
    expect(startCalls()[0]!.body).toEqual({ transcriptText: 'Tomas Reyes at Fenwick Capital joined.', title: 'Seed call' });
    expect((started[0] as { id: string }).id).toBe('run_tr');
  });

  it('leaves the title out of the body when the call name is blank', async () => {
    const { user } = await ready();
    fireEvent.change(textBox(), { target: { value: 'Tomas Reyes joined.' } });
    await user.click(submitButton());
    await waitFor(() => expect(started).toHaveLength(1));
    expect(startCalls()[0]!.body).toEqual({ transcriptText: 'Tomas Reyes joined.' });
  });
});

describe('transcript import review', () => {
  const counts = { fetched: 2, staged: 2, duplicates: 0, invalid: 0 };
  const payload = {
    batchId: 'imp_tr',
    transcript: true,
    counts,
    sample: [
      { name: 'Tomas Reyes', email: null, company: 'Fenwick Capital', title: 'Partner', kind: 'person', quote: 'Tomas Reyes at Fenwick Capital suggested we talk.' },
      { name: null, email: null, company: 'Marlowe Ridge Partners', title: null, kind: 'organization', quote: 'Marlowe Ridge Partners, a family office.' },
    ],
  };

  it('parses the transcript flag and the quotes', () => {
    const review = parseImportReviewPayload(payload)!;
    expect(review.transcript).toBe(true);
    expect(review.pasted).toBe(false);
    expect(review.sample.map((row) => row.quote)).toEqual(['Tomas Reyes at Fenwick Capital suggested we talk.', 'Marlowe Ridge Partners, a family office.']);
    expect(parseImportReviewPayload({ batchId: 'imp_1', counts, sample: [] })!.transcript).toBe(false);
  });

  it('shows the source line and a quote column in the approval sample', () => {
    const review = parseImportReviewPayload(payload)!;
    const approval = { id: 'apr_1', runId: 'run_tr', kind: 'import_review', status: 'pending', payload } as unknown as Approval;
    render(
      <Router>
        <ImportReviewBody approval={approval} review={review} />
      </Router>,
    );
    expect(screen.getByText('From a pasted call transcript')).toBeInTheDocument();
    expect(screen.queryByText(/From pasted post text/)).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Quote' })).toBeInTheDocument();
    expect(screen.getByText('Tomas Reyes at Fenwick Capital suggested we talk.')).toBeInTheDocument();
    expect(screen.getByText('Organization')).toBeInTheDocument();
  });

  it('labels the batch sheet and shows each row quote as a From the call line', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Router>
          <ImportBatchSheet id="imp_tr" onClose={() => {}} />
        </Router>
      </QueryClientProvider>,
    );
    await screen.findByText('Tomas Reyes');
    expect(screen.getByText('From a pasted call transcript')).toBeInTheDocument();
    expect(screen.getByText('From the call: Tomas Reyes at Fenwick Capital suggested we talk.')).toBeInTheDocument();
    expect(screen.queryByText(/From the post/)).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Title' })).toBeInTheDocument();
  });
});
