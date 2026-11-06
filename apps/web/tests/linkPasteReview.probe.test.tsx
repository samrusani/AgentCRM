// Adversarial probes for the pasted post text and lnkd.in short link entry. Names start with KILLS (a bug or attack
// the review found stays fixed).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeadCaptureCard } from '../src/screens/LeadCaptureCard';
import { isLnkdInShortUrl, isPostLink, withHttps } from '../src/lib/leads';
import { Router } from './helpers';

interface Call {
  method: string;
  path: string;
  body: Record<string, any> | undefined;
}

interface World {
  apify: 'connected' | 'missing' | 'hang';
  provider: 'ready' | 'none';
  runStatus: number;
}

let world: World;
let calls: Call[];

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
      if (url.pathname === '/api/connectors' && method === 'GET') {
        if (world.apify === 'hang') return new Promise<Response>(() => undefined);
        const items = world.apify === 'missing' ? [] : [{ id: 'con_1', kind: 'apify', status: 'connected', settings: { allowlist: [] } }];
        return json(200, { items });
      }
      if (url.pathname === '/api/model-provider' && method === 'GET') {
        return json(200, world.provider === 'ready' ? { kind: 'anthropic', model: 'claude-opus-5-5', status: 'connected', ready: true } : {});
      }
      if (url.pathname === '/api/runs' && method === 'POST') {
        if (world.runStatus !== 201) return json(world.runStatus, { error: { code: 'validation', message: 'The server said no.' } });
        return json(201, { id: 'run_new', kind: 'lead_capture', title: 'x', status: 'queued', scope: body?.scope ?? {}, counts: {}, steps: [] });
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
        <LeadCaptureCard onStarted={() => undefined} />
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

const submitButton = () => screen.getByRole('button', { name: 'Capture leads' });
const modeButton = (name: 'Post link' | 'Pasted text') => screen.getByRole('button', { name });
const urlBox = () => screen.getByPlaceholderText('Paste a LinkedIn post URL');
const textBox = () => screen.getByPlaceholderText('Paste the post text');
const linkBox = () => screen.getByLabelText('Post link (optional)');
const enrichToggle = () => screen.getByRole('checkbox', { name: 'Enrich new people' });
const runCalls = () => calls.filter((call) => call.method === 'POST' && call.path === '/api/runs');
const reasonLine = () => document.getElementById('lead-capture-reason')!;

async function settled() {
  await waitFor(() => expect(calls.filter((call) => call.method === 'GET').length).toBeGreaterThanOrEqual(2));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'People named in the post' })).toBeEnabled());
}

beforeEach(() => {
  world = { apify: 'connected', provider: 'ready', runStatus: 201 };
  calls = [];
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('mode switching never leaks the other mode fields', () => {
  it('KILLS: a link submit after typing text sends no postText, and a pasted submit sends no postUrl unless typed in the optional field', async () => {
    const { user } = renderCard();
    await settled();
    await user.type(urlBox(), 'https://lnkd.in/aBc-12_3');
    await user.click(modeButton('Pasted text'));
    fireEvent.change(textBox(), { target: { value: 'Ben Marsh writes first cheques.' } });
    // Pasted submit: the link typed in link mode must not ride along.
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0]!.body!.scope).toEqual({ postText: 'Ben Marsh writes first cheques.', maxPeople: 50, enrich: false });
    // Back to link mode: the URL is still there, the text is not sent.
    await user.click(modeButton('Post link'));
    expect(urlBox()).toHaveValue('https://lnkd.in/aBc-12_3');
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(2));
    const scope = runCalls()[1]!.body!.scope;
    expect(scope).toMatchObject({ postUrl: 'https://lnkd.in/aBc-12_3', enrich: true });
    expect(scope).not.toHaveProperty('postText');
  });

  it('KILLS: each mode keeps its own enrich choice, so a pasted opt in never turns on enrichment for a link run', async () => {
    const { user } = renderCard();
    await settled();
    await user.click(modeButton('Pasted text'));
    await user.click(enrichToggle());
    expect(enrichToggle()).toBeChecked();
    await user.click(modeButton('Post link'));
    expect(enrichToggle()).toBeChecked();
    await user.click(enrichToggle());
    await user.click(modeButton('Pasted text'));
    // Still on in pasted mode: the two toggles are independent.
    expect(enrichToggle()).toBeChecked();
  });

  it('KILLS: a pasted submit sends no sources key at all', async () => {
    const { user } = renderCard();
    await settled();
    await user.click(modeButton('Pasted text'));
    fireEvent.change(textBox(), { target: { value: 'Some text.' } });
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0]!.body!.scope).not.toHaveProperty('sources');
  });
});

describe('link shapes', () => {
  it('KILLS: the client link check matches the server shape for short links', () => {
    // lnkd.in/p/<slug> joined the accepted shape when the contract gained the mobile share sheet's one letter section.
    for (const ok of ['https://lnkd.in/aBc', 'http://www.lnkd.in/a_b-C/', 'https://LNKD.IN/ABC', 'https://lnkd.in/abc?trk=1#x', `https://lnkd.in/${'a'.repeat(64)}`, 'https://lnkd.in/p/eiR7_BHD']) {
      expect(isLnkdInShortUrl(ok), ok).toBe(true);
    }
    for (const bad of ['https://lnkd.in/', 'https://lnkd.in/ab/cd', 'https://lnkd.in/p/ab/cd', `https://lnkd.in/${'a'.repeat(65)}`, 'https://lnkd.in:8443/a', 'https://u@lnkd.in/a', 'https://lnkd.in.evil.com/a', 'https://xlnkd.in/a', 'ftp://lnkd.in/a', 'https://lnkd.in/a b']) {
      expect(isLnkdInShortUrl(bad), bad).toBe(false);
    }
    expect(withHttps('LNKD.IN/aBc')).toBe('https://LNKD.IN/aBc');
    expect(isPostLink(withHttps('LNKD.IN/aBc'))).toBe(true);
    expect(withHttps('lnkd.in.evil.com/a')).toBe('lnkd.in.evil.com/a');
    expect(isPostLink(withHttps('foo.lnkd.in/a'))).toBe(false);
  });
});

describe('pasted text bounds', () => {
  it('KILLS: the 15,000 cut is measured on the trimmed text, so surrounding whitespace never costs real text', async () => {
    // The server trims before it counts ("1 to 15,000 characters after trimming"), so the client keeps the whitespace the
    // person typed and cuts only when the trimmed text is longer than the limit.
    const { user } = renderCard();
    await settled();
    await user.click(modeButton('Pasted text'));
    const padded = `${' '.repeat(200)}${'x'.repeat(15000)}${'\n'.repeat(50)}`;
    fireEvent.change(textBox(), { target: { value: padded } });
    expect((textBox() as HTMLTextAreaElement).value).toBe(padded);
    expect(screen.queryByText(/The text was longer/)).not.toBeInTheDocument();
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(String(runCalls()[0]!.body!.scope.postText).trim()).toHaveLength(15000);
    // One real character over the limit is cut, leading whitespace kept, and the line says so.
    fireEvent.change(textBox(), { target: { value: `${' '.repeat(200)}${'x'.repeat(15001)}` } });
    const value = (textBox() as HTMLTextAreaElement).value;
    expect(value.startsWith(' '.repeat(200))).toBe(true);
    expect(value.trim()).toHaveLength(15000);
    expect(screen.getByText(/The text was longer, so the first 15,000 were kept\./)).toBeInTheDocument();
  });

  it('KILLS: the cut never splits a surrogate pair, so no lone surrogate is submitted', async () => {
    // 14,999 characters then an emoji puts the pair across the 15,000 limit: the cut goes one code unit earlier.
    const { user } = renderCard();
    await settled();
    await user.click(modeButton('Pasted text'));
    fireEvent.change(textBox(), { target: { value: `${'a'.repeat(14999)}\u{1F600}tail` } });
    const value = (textBox() as HTMLTextAreaElement).value;
    expect(value).toHaveLength(14999);
    const last = value.charCodeAt(value.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(screen.getByText(/The text was longer, so the first 15,000 were kept\./)).toBeInTheDocument();
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    const sent = String(runCalls()[0]!.body!.scope.postText);
    expect(sent).toHaveLength(14999);
    expect(sent.isWellFormed()).toBe(true);
    // A pair that fits whole is kept.
    fireEvent.change(textBox(), { target: { value: `${'a'.repeat(14998)}\u{1F600}tail` } });
    expect((textBox() as HTMLTextAreaElement).value).toBe(`${'a'.repeat(14998)}\u{1F600}`);
  });
});

describe('Apify state', () => {
  it('KILLS: with enrichment on, the reason line says the connection could not be checked yet, never "not connected", while the check is loading', async () => {
    world.apify = 'hang';
    const { user } = renderCard();
    await user.click(modeButton('Pasted text'));
    fireEvent.change(textBox(), { target: { value: 'Some text.' } });
    await waitFor(() => expect(enrichToggle()).toBeEnabled());
    await user.click(enrichToggle());
    expect(reasonLine()).toHaveTextContent('Could not check the Apify connection yet. Turn off enrichment or check Apify in Settings.');
    expect(reasonLine()).not.toHaveTextContent('Apify is not connected');
  });

  it('KILLS: with Apify missing the enrich toggle is locked, links to connectors, and the capture itself still submits', async () => {
    const { user } = renderCard();
    await settled();
    await user.click(modeButton('Pasted text'));
    fireEvent.change(textBox(), { target: { value: 'Some text.' } });
    await user.click(enrichToggle());
    world.apify = 'missing';
    // Reload the connectors read by remounting the card.
    cleanup();
    calls = [];
    const again = renderCard();
    await waitFor(() => expect(calls.some((call) => call.path === '/api/connectors')).toBe(true));
    await again.user.click(modeButton('Pasted text'));
    fireEvent.change(textBox(), { target: { value: 'Some text.' } });
    await waitFor(() => expect(enrichToggle()).toBeDisabled());
    expect(submitButton()).toBeEnabled();
    expect(within(document.querySelector('.lead-capture')!).getByRole('link', { name: 'Connect Apify in Settings' })).toHaveAttribute('href', '/settings/connectors');
  });
});

describe('start errors', () => {
  it('KILLS: switching modes clears a previous start error, in both directions', async () => {
    world.runStatus = 400;
    const { user } = renderCard();
    await settled();
    await user.type(urlBox(), 'https://lnkd.in/aBc');
    await user.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start the capture.');
    await user.click(modeButton('Pasted text'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(textBox(), { target: { value: 'Some text.' } });
    await user.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start the capture.');
    await user.click(modeButton('Post link'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Pressing the mode that is already active keeps nothing it should not: a fresh error from this form stays.
    await user.click(submitButton());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.click(modeButton('Post link'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
