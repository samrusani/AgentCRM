// Adversarial review probes for the call transcript capture web wave. KILLS: the attack failed, or a bug was found and fixed, and the safe behavior is
// pinned. CONFIRMS: a live bug, asserted as it behaves today with a comment on what correct would be. ACCEPTED: a
// limit the contract allows. Nothing here changes application code.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Approval } from '../src/api/types';
import { ImportReviewBody } from '../src/components/importReview';
import { MAX_TRANSCRIPT_LENGTH } from '../src/lib/leads';
import { parseImportReviewPayload } from '../src/lib/imports';
import { ImportBatchSheet } from '../src/screens/ImportSheets';
import { TranscriptCaptureCard } from '../src/screens/TranscriptCaptureCard';
import { Router } from './helpers';

vi.mock('../src/lib/ui', () => ({
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

let providerReady = true;
let calls: Call[];
let releaseStart: (() => void) | null = null;
let startMode: 'ok' | 'slow' | 'refuse';
let batchItems: Record<string, unknown>[];
const started: unknown[] = [];

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
      if (url.pathname === '/api/model-provider') {
        return json(200, providerReady ? { kind: 'anthropic', model: 'claude-opus-5-5', status: 'connected', ready: true } : {});
      }
      if (url.pathname === '/api/imports/transcript' && method === 'POST') {
        if (startMode === 'refuse') return json(400, { error: { code: 'validation', message: 'Use a transcript of at most 60,000 characters.' } });
        if (startMode === 'slow') await new Promise<void>((resolve) => (releaseStart = resolve));
        return json(201, { id: 'run_tr', kind: 'transcript_capture', title: 'Call transcript capture', status: 'queued', scope: {}, counts: {}, steps: [] });
      }
      if (url.pathname === '/api/imports/imp_h') {
        return json(200, {
          id: 'imp_h',
          runId: 'run_h',
          sourceKind: 'transcript',
          sourceRef: { transcript: true },
          status: 'awaiting_review',
          counts: { fetched: batchItems.length, staged: batchItems.length, duplicates: 0, invalid: 0 },
          items: batchItems,
          nextCursor: null,
        });
      }
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

beforeEach(() => {
  providerReady = true;
  calls = [];
  started.length = 0;
  startMode = 'ok';
  releaseStart = null;
  batchItems = [];
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

const submitButton = () => screen.getByRole('button', { name: /Stage people for review|Starting/ });
const textBox = () => screen.getByPlaceholderText('Paste the call transcript') as HTMLTextAreaElement;
const startCalls = () => calls.filter((call) => call.method === 'POST' && call.path === '/api/imports/transcript');
const providerSettled = () => waitFor(() => expect(calls.some((call) => call.path === '/api/model-provider')).toBe(true));

describe('hostile strings render as text', () => {
  const hostile = {
    name: '<img src=x onerror="window.__pwned=1">Tomas',
    company: '<script>window.__pwned=2</script>Fenwick',
    title: '"><svg onload=window.__pwned=3>',
    quote: '<a href="javascript:window.__pwned=4">click</a> & <b>bold</b>',
  };

  it('KILLS: the approval card shows name, company, title, and quote as literal text with no injected elements', () => {
    const payload = {
      batchId: 'imp_h',
      transcript: true,
      counts: { fetched: 1, staged: 1, duplicates: 0, invalid: 0 },
      sample: [{ ...hostile, email: null, kind: 'person' }],
    };
    const review = parseImportReviewPayload(payload)!;
    const approval = { id: 'apr_h', runId: 'run_h', kind: 'import_review', status: 'pending', payload } as unknown as Approval;
    const { container } = render(
      <Router>
        <ImportReviewBody approval={approval} review={review} />
      </Router>,
    );
    for (const value of [hostile.name, hostile.company, hostile.title, hostile.quote]) expect(screen.getByText(value)).toBeInTheDocument();
    expect(container.querySelector('img, script, svg, b')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('KILLS: the batch sheet shows a hostile name and call quote as literal text', async () => {
    batchItems = [{ seq: 1, status: 'staged', mapped: { name: hostile.name, company: hostile.company, title: hostile.title }, raw: { quote: hostile.quote, extracted: true } }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <Router>
          <ImportBatchSheet id="imp_h" onClose={() => {}} />
        </Router>
      </QueryClientProvider>,
    );
    await screen.findByText(hostile.name);
    expect(screen.getByText(`From the call: ${hostile.quote}`)).toBeInTheDocument();
    expect(container.querySelector('table img, table script, table svg, table b')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('KILLS: no web source file uses dangerouslySetInnerHTML or assigns innerHTML', () => {
    const root = path.join(__dirname, '..', 'src');
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?)$/.test(entry)) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=/);
  });

  it('KILLS: the payload parser takes only a real true as the transcript flag; a numeric quote is shown as its text and an object quote is dropped', () => {
    const counts = { fetched: 1, staged: 1, duplicates: 0, invalid: 0 };
    expect(parseImportReviewPayload({ batchId: 'imp_1', counts, transcript: 'true', sample: [] })!.transcript).toBe(false);
    expect(parseImportReviewPayload({ batchId: 'imp_1', counts, transcript: 1, sample: [] })!.transcript).toBe(false);
    const sample = parseImportReviewPayload({ batchId: 'imp_1', counts, transcript: true, sample: [{ name: 'A', quote: 5 }, { name: 'B', quote: { x: 1 } }, null, 'row'] })!.sample;
    expect(sample.map((row) => row.quote ?? null).slice(0, 2)).toEqual(['5', null]);
    expect(parseImportReviewPayload({ batchId: 'imp_1', counts, transcript: true, sample: 'nope' })!.sample).toEqual([]);
  });

  it('KILLS: a sample row with no quote shows the muted placeholder, and an organization row shows no person fields', () => {
    const payload = {
      batchId: 'imp_h',
      transcript: true,
      counts: { fetched: 2, staged: 2, duplicates: 0, invalid: 0 },
      sample: [
        { name: 'Tomas Reyes', email: 'tomas@example.com', company: null, title: 'Partner', kind: 'person', quote: null },
        { name: null, email: 'ghost@example.com', company: 'Marlowe Ridge Partners', title: 'Should not show', kind: 'organization', quote: 'Marlowe.' },
      ],
    };
    const approval = { id: 'apr_h', runId: 'run_h', kind: 'import_review', status: 'pending', payload } as unknown as Approval;
    render(
      <Router>
        <ImportReviewBody approval={approval} review={parseImportReviewPayload(payload)!} />
      </Router>,
    );
    expect(screen.getByText('No quote')).toBeInTheDocument();
    expect(screen.queryByText('ghost@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('Should not show')).not.toBeInTheDocument();
  });

  it('KILLS: the approval table shows the profile link of a transcript row, now that the sample carries linkedinUrl', () => {
    // The server's transcript sample row carries linkedinUrl like lead capture does, so the Profile column renders the
    // real profile instead of "No profile".
    const payload = {
      batchId: 'imp_h',
      transcript: true,
      counts: { fetched: 1, staged: 1, duplicates: 0, invalid: 0 },
      sample: [{ name: 'Noor Ellery', email: null, company: 'Quillan Labs', title: 'Product lead', linkedinUrl: 'https://www.linkedin.com/in/noor-ellery', kind: 'person', quote: 'Noor Ellery leads product.' }],
    };
    const approval = { id: 'apr_h', runId: 'run_h', kind: 'import_review', status: 'pending', payload } as unknown as Approval;
    render(
      <Router>
        <ImportReviewBody approval={approval} review={parseImportReviewPayload(payload)!} />
      </Router>,
    );
    expect(screen.getByRole('columnheader', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.queryByText('No profile')).not.toBeInTheDocument();
    expect(screen.getByTitle('https://www.linkedin.com/in/noor-ellery')).toBeInTheDocument();
  });
});

describe('submit states', () => {
  it('KILLS: the button stays disabled until the provider check says ready, whatever is typed', async () => {
    providerReady = false;
    renderCard();
    await providerSettled();
    fireEvent.change(textBox(), { target: { value: 'Tomas Reyes joined.' } });
    expect(submitButton()).toBeDisabled();
    fireEvent.submit(textBox().closest('form')!);
    expect(startCalls()).toHaveLength(0);
  });

  it('KILLS: submitting the form with Enter on the empty or whitespace only text posts nothing', async () => {
    const { user } = renderCard();
    await providerSettled();
    await waitFor(() => expect(submitButton()).toBeDisabled());
    await user.type(screen.getByLabelText('Call name (optional)'), 'Seed call{Enter}');
    fireEvent.change(textBox(), { target: { value: ' \n\t ' } });
    fireEvent.submit(textBox().closest('form')!);
    expect(startCalls()).toHaveLength(0);
  });

  it('KILLS: a second submit while the first is pending does not post twice', async () => {
    startMode = 'slow';
    renderCard();
    await providerSettled();
    fireEvent.change(textBox(), { target: { value: 'Tomas Reyes joined.' } });
    await waitFor(() => expect(submitButton()).toBeEnabled());
    fireEvent.submit(textBox().closest('form')!);
    await waitFor(() => expect(startCalls()).toHaveLength(1));
    expect(submitButton()).toBeDisabled();
    fireEvent.submit(textBox().closest('form')!);
    fireEvent.submit(textBox().closest('form')!);
    expect(startCalls()).toHaveLength(1);
    releaseStart?.();
    await waitFor(() => expect(started).toHaveLength(1));
  });

  it('KILLS: a refused start shows the server sentence in an alert, keeps the text, and re-enables the button', async () => {
    startMode = 'refuse';
    const { user } = renderCard();
    await providerSettled();
    fireEvent.change(textBox(), { target: { value: 'Tomas Reyes joined.' } });
    await waitFor(() => expect(submitButton()).toBeEnabled());
    await user.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Use a transcript of at most 60,000 characters.');
    expect(textBox().value).toBe('Tomas Reyes joined.');
    expect(submitButton()).toBeEnabled();
    expect(started).toHaveLength(0);
  });

  it('KILLS: the call name is capped at 200 characters by the field and a blank name is left out of the body', async () => {
    const { user } = renderCard();
    await providerSettled();
    expect(screen.getByLabelText('Call name (optional)')).toHaveAttribute('maxlength', '200');
    fireEvent.change(textBox(), { target: { value: 'Tomas Reyes joined.' } });
    await user.type(screen.getByLabelText('Call name (optional)'), '    ');
    await waitFor(() => expect(submitButton()).toBeEnabled());
    await user.click(submitButton());
    await waitFor(() => expect(started).toHaveLength(1));
    expect(startCalls()[0]!.body).toEqual({ transcriptText: 'Tomas Reyes joined.' });
  });
});

describe('the 60,000 character cut', () => {
  it('KILLS: exactly 60,000 characters is kept whole with no cut note', async () => {
    renderCard();
    await providerSettled();
    fireEvent.change(textBox(), { target: { value: 'x'.repeat(MAX_TRANSCRIPT_LENGTH) } });
    expect(textBox().value.length).toBe(MAX_TRANSCRIPT_LENGTH);
    expect(screen.queryByText(/The text was longer/)).not.toBeInTheDocument();
  });

  it('KILLS: padding whitespace does not count, and what is posted trims to at most 60,000', async () => {
    const { user } = renderCard();
    await providerSettled();
    fireEvent.change(textBox(), { target: { value: `   \n${'x'.repeat(MAX_TRANSCRIPT_LENGTH)}   ` } });
    expect(screen.queryByText(/The text was longer/)).not.toBeInTheDocument();
    fireEvent.change(textBox(), { target: { value: `   \n${'x'.repeat(MAX_TRANSCRIPT_LENGTH + 5)}` } });
    expect(screen.getByText(/The text was longer/)).toBeInTheDocument();
    expect(textBox().value.trim().length).toBe(MAX_TRANSCRIPT_LENGTH);
    await waitFor(() => expect(submitButton()).toBeEnabled());
    await user.click(submitButton());
    await waitFor(() => expect(started).toHaveLength(1));
    expect(String(startCalls()[0]!.body!.transcriptText).trim().length).toBe(MAX_TRANSCRIPT_LENGTH);
  });

  it('KILLS: a cut behind leading whitespace never leaves half an emoji', async () => {
    renderCard();
    await providerSettled();
    fireEvent.change(textBox(), { target: { value: `  ${'x'.repeat(MAX_TRANSCRIPT_LENGTH - 1)}\u{1F600}${'y'.repeat(50)}` } });
    const kept = textBox().value;
    expect(kept.endsWith('x')).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(kept)).toBe(false);
    expect(kept.trim().length).toBe(MAX_TRANSCRIPT_LENGTH - 1);
  });

  it('KILLS: the cut note clears once the person edits the text back under the limit', async () => {
    renderCard();
    await providerSettled();
    fireEvent.change(textBox(), { target: { value: 'x'.repeat(MAX_TRANSCRIPT_LENGTH + 10) } });
    expect(screen.getByText(/The text was longer/)).toBeInTheDocument();
    fireEvent.change(textBox(), { target: { value: 'short transcript' } });
    expect(screen.queryByText(/The text was longer/)).not.toBeInTheDocument();
  });

  it('ACCEPTED: the client counts UTF-16 units like the server, so a paste of astral characters is cut earlier than 60,000 visible characters', async () => {
    renderCard();
    await providerSettled();
    fireEvent.change(textBox(), { target: { value: '\u{1F600}'.repeat(MAX_TRANSCRIPT_LENGTH) } });
    expect(textBox().value.length).toBe(MAX_TRANSCRIPT_LENGTH);
    expect(Array.from(textBox().value).length).toBe(MAX_TRANSCRIPT_LENGTH / 2);
  });
});
