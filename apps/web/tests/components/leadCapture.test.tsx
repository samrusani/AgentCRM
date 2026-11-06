import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Approval } from '../../src/api/types';
import { ImportReviewBody } from '../../src/components/importReview';
import { parseImportReviewPayload } from '../../src/lib/imports';
import { LeadCaptureCard } from '../../src/screens/LeadCaptureCard';
import { Router } from '../helpers';

interface Call {
  method: string;
  path: string;
  body: Record<string, any> | undefined;
}

interface World {
  apify: 'connected' | 'missing' | 'error' | 'check-failed';
  provider: 'ready' | 'none' | 'check-failed';
}

let world: World;
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
      if (url.pathname === '/api/connectors' && method === 'GET') {
        if (world.apify === 'check-failed') return json(500, { error: { code: 'internal', message: 'Down.' } });
        const items =
          world.apify === 'missing'
            ? []
            : [{ id: 'con_1', kind: 'apify', status: world.apify === 'error' ? 'error' : 'connected', settings: { allowlist: [] } }];
        return json(200, { items });
      }
      if (url.pathname === '/api/model-provider' && method === 'GET') {
        if (world.provider === 'check-failed') return json(500, { error: { code: 'internal', message: 'Down.' } });
        return json(200, world.provider === 'ready' ? { kind: 'anthropic', model: 'claude-opus-5-5', status: 'connected', ready: true } : {});
      }
      if (url.pathname === '/api/runs' && method === 'POST') {
        return json(201, { id: 'run_new', kind: 'lead_capture', title: 'LinkedIn lead capture', status: 'queued', scope: body?.scope ?? {}, counts: {}, steps: [] });
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
        <LeadCaptureCard onStarted={(run) => started.push(run)} />
      </Router>
    </QueryClientProvider>,
  );
  return { user, client };
}

const submitButton = () => screen.getByRole('button', { name: 'Capture leads' });
const modeButton = (name: 'Post link' | 'Pasted text') => screen.getByRole('button', { name });
const textBox = () => screen.getByPlaceholderText('Paste the post text');
const linkBox = () => screen.getByLabelText('Post link (optional)');
const enrichToggle = () => screen.getByRole('checkbox', { name: 'Enrich new people' });

function setText(value: string) {
  fireEvent.change(textBox(), { target: { value } });
}

async function openPasted() {
  const { user, client } = renderCard();
  // Wait for the connector and provider reads to land, so the state under test is settled.
  await waitFor(() => expect(calls.filter((call) => call.method === 'GET').length).toBeGreaterThanOrEqual(2));
  await user.click(modeButton('Pasted text'));
  await waitFor(() => expect(calls.filter((call) => call.path === '/api/model-provider').length).toBeGreaterThanOrEqual(1));
  return { user, client };
}

const runCalls = () => calls.filter((call) => call.method === 'POST' && call.path === '/api/runs');

beforeEach(() => {
  world = { apify: 'connected', provider: 'ready' };
  calls = [];
  started = [];
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mode switch', () => {
  it('renders the two options with link mode first', async () => {
    renderCard();
    expect(screen.getByRole('heading', { name: 'From a LinkedIn post' })).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Capture from' });
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual(['Post link', 'Pasted text']);
    expect(modeButton('Post link')).toHaveAttribute('aria-pressed', 'true');
    expect(modeButton('Pasted text')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByPlaceholderText('Paste a LinkedIn post URL')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Paste the post text')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'People who reacted' })).toBeInTheDocument();
  });

  it('shows the pasted fields and hides the engagement checkboxes in pasted mode', async () => {
    const { user } = renderCard();
    await user.click(modeButton('Pasted text'));
    expect(modeButton('Pasted text')).toHaveAttribute('aria-pressed', 'true');
    expect(textBox()).toBeInTheDocument();
    expect(linkBox()).toBeInTheDocument();
    expect(screen.getByText('Up to 15,000 characters.')).toBeInTheDocument();
    expect(screen.getByText('Captures the people and organizations named in the text. Reactions and comments need a post link.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'People who reacted' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('People per source')).toHaveValue(50);
    await user.click(modeButton('Post link'));
    expect(screen.queryByPlaceholderText('Paste the post text')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Paste a LinkedIn post URL')).toBeInTheDocument();
  });
});

describe('pasted mode', () => {
  it('starts with enrichment off, and submits with valid text', async () => {
    const { user } = await openPasted();
    expect(enrichToggle()).not.toBeChecked();
    expect(enrichToggle()).toBeEnabled();
    expect(screen.getByLabelText('Most new people to enrich')).toBeDisabled();
    expect(submitButton()).toBeDisabled();
    setText('Seed season is open. Ben Marsh at Harbor Row writes the fastest first cheques.');
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0]!.body).toEqual({
      kind: 'lead_capture',
      scope: { postText: 'Seed season is open. Ben Marsh at Harbor Row writes the fastest first cheques.', maxPeople: 50, enrich: false },
    });
    expect(runCalls()[0]!.body!.scope).not.toHaveProperty('sources');
    expect(runCalls()[0]!.body!.scope).not.toHaveProperty('postUrl');
    await waitFor(() => expect(started).toHaveLength(1));
  });

  it('sends the optional link with https added and the enrichment limit when enrichment is on', async () => {
    const { user } = await openPasted();
    setText('Some post text.');
    await user.type(linkBox(), 'linkedin.com/posts/jane-doe_topic-activity-7100000000000000001-AbCd');
    await user.click(enrichToggle());
    expect(screen.getByLabelText('Most new people to enrich')).toBeEnabled();
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0]!.body!.scope).toEqual({
      postText: 'Some post text.',
      postUrl: 'https://linkedin.com/posts/jane-doe_topic-activity-7100000000000000001-AbCd',
      maxPeople: 50,
      enrich: true,
      enrichLimit: 25,
    });
  });

  it('accepts a lnkd.in short link as the optional link', async () => {
    const { user } = await openPasted();
    setText('Some post text.');
    await user.type(linkBox(), 'lnkd.in/aBc-12_3');
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0]!.body!.scope.postUrl).toBe('https://lnkd.in/aBc-12_3');
  });

  it('disables the button with a reason when the text is empty or only spaces', async () => {
    await openPasted();
    expect(submitButton()).toBeDisabled();
    expect(screen.getByText('Paste the post text to capture leads.')).toBeInTheDocument();
    setText('   \n  ');
    expect(submitButton()).toBeDisabled();
    expect(screen.getByText('Paste the post text to capture leads.')).toBeInTheDocument();
  });

  it('disables the button and explains an optional link that does not look like a post', async () => {
    const { user } = await openPasted();
    setText('Some post text.');
    await user.type(linkBox(), 'https://example.com/post/1');
    expect(submitButton()).toBeDisabled();
    expect(linkBox()).toHaveAttribute('aria-invalid', 'true');
    expect(linkBox()).toHaveAccessibleDescription(/This does not look like a LinkedIn post\. Use a link such as .*lnkd\.in short link/);
    expect(screen.getByText('Fix the post link first.')).toBeInTheDocument();
    await user.clear(linkBox());
    expect(submitButton()).toBeEnabled();
    expect(linkBox()).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('needs a ready model provider, says how to get one, and keeps the button disabled', async () => {
    world.provider = 'none';
    const { user } = renderCard();
    await user.click(modeButton('Pasted text'));
    setText('Some post text.');
    const line = await screen.findByText(/to read people from the post text\./);
    expect(within(line).getByRole('link', { name: 'model provider' })).toHaveAttribute('href', '/settings/models');
    expect(submitButton()).toBeDisabled();
  });

  it('says the provider could not be checked when that read fails', async () => {
    world.provider = 'check-failed';
    const { user } = renderCard();
    await user.click(modeButton('Pasted text'));
    setText('Some post text.');
    expect(await screen.findByText('Could not check the model provider.')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('keeps capture working when Apify is not connected, and explains why enrichment is off', async () => {
    world.apify = 'missing';
    const { user } = renderCard();
    await user.click(modeButton('Pasted text'));
    setText('Some post text.');
    await waitFor(() => expect(enrichToggle()).toBeDisabled());
    const line = screen.getByText(/to enrich new people\. The capture works without it\./);
    expect(within(line).getByRole('link', { name: 'Connect Apify in Settings' })).toHaveAttribute('href', '/settings/connectors');
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0]!.body!.scope).toEqual({ postText: 'Some post text.', maxPeople: 50, enrich: false });
  });

  it('disables enrichment the same way when the Apify token was rejected or the check failed', async () => {
    for (const apify of ['error', 'check-failed'] as const) {
      world = { apify, provider: 'ready' };
      calls = [];
      const { user } = renderCard();
      await user.click(modeButton('Pasted text'));
      setText('Some post text.');
      await waitFor(() => expect(enrichToggle()).toBeDisabled());
      expect(screen.getByRole('link', { name: 'Connect Apify in Settings' })).toHaveAttribute('href', '/settings/connectors');
      expect(submitButton()).toBeEnabled();
      cleanup();
    }
  });

  it('blocks the capture with a reason when enrichment is on and Apify stops being connected, and lets the person turn enrichment off', async () => {
    const { user, client } = await openPasted();
    setText('Some post text.');
    await user.click(enrichToggle());
    expect(submitButton()).toBeEnabled();
    // Apify was removed in another tab, and the connection read lands again.
    world.apify = 'missing';
    await client.invalidateQueries({ queryKey: ['connectors'] });
    await waitFor(() => expect(submitButton()).toBeDisabled());
    const reason = document.getElementById('lead-capture-reason')!;
    expect(reason).toHaveTextContent('Apify is not connected. Turn off enrichment or check Apify in Settings.');
    expect(within(reason).getByRole('link', { name: 'check Apify in Settings' })).toHaveAttribute('href', '/settings/connectors');
    // The toggle stays usable while it is on, so enrichment can be turned off and the capture can go on.
    expect(enrichToggle()).toBeEnabled();
    await user.click(enrichToggle());
    expect(enrichToggle()).not.toBeChecked();
    expect(submitButton()).toBeEnabled();
  });

  it('shows the live count only near the limit and keeps the first 15,000 characters of a longer paste', async () => {
    await openPasted();
    setText('a'.repeat(13999));
    expect(screen.getByText('Up to 15,000 characters.')).toBeInTheDocument();
    setText('a'.repeat(14000));
    expect(screen.getByText('Up to 15,000 characters. 14,000 used.')).toBeInTheDocument();
    setText('a'.repeat(15000));
    expect(screen.getByText('Up to 15,000 characters. 15,000 used.')).toBeInTheDocument();
    setText('b'.repeat(15001));
    expect(textBox()).toHaveValue('b'.repeat(15000));
    expect(screen.getByText('Up to 15,000 characters. The text was longer, so the first 15,000 were kept.')).toBeInTheDocument();
    // Editing the text back inside the limit clears the note.
    setText('c'.repeat(100));
    expect(screen.getByText('Up to 15,000 characters.')).toBeInTheDocument();
  });

  it('submits the cut text, not the longer paste', async () => {
    const { user } = await openPasted();
    setText('d'.repeat(20000));
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0]!.body!.scope.postText).toHaveLength(15000);
  });

  it('says reading the text spends model usage and nothing else when enrichment is off, and adds the profile price when it is on', async () => {
    const { user } = await openPasted();
    const note = () => document.querySelector('.lead-capture__note')!.textContent!;
    expect(note()).toContain('Reading the text uses your model provider; costs shown are estimates.');
    expect(note()).not.toContain('$');
    expect(note()).not.toContain('Apify');
    await user.click(enrichToggle());
    expect(note()).toContain('$4.00 per 1,000');
    expect(note()).toContain('Apify account');
    expect(note()).not.toContain('$5.00');
  });
});

describe('link mode', () => {
  async function openLink() {
    const { user } = renderCard();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'People named in the post' })).toBeEnabled());
    return { user };
  }

  it('accepts a lnkd.in short link, with or without the scheme', async () => {
    const { user } = await openLink();
    const box = screen.getByPlaceholderText('Paste a LinkedIn post URL');
    await user.type(box, 'lnkd.in/aBc-12_3');
    expect(submitButton()).toBeEnabled();
    expect(box).not.toHaveAttribute('aria-invalid', 'true');
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0]!.body!.scope).toMatchObject({ postUrl: 'https://lnkd.in/aBc-12_3', sources: ['post', 'reactions', 'comments'], enrich: true });
    expect(runCalls()[0]!.body!.scope).not.toHaveProperty('postText');

    await user.clear(box);
    await user.type(box, 'https://www.lnkd.in/xyz');
    expect(submitButton()).toBeEnabled();
  });

  it('tidies a link copied out of post text and sends the tidied link', async () => {
    const { user } = await openLink();
    const box = screen.getByPlaceholderText('Paste a LinkedIn post URL');
    await user.type(box, '(https://lnkd.in/gvRk3_u9).');
    expect(submitButton()).toBeEnabled();
    expect(box).not.toHaveAttribute('aria-invalid', 'true');
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0]!.body!.scope.postUrl).toBe('https://lnkd.in/gvRk3_u9');

    await user.clear(box);
    await user.type(box, 'https://lnkd.in/gvRk3_u9​…');
    expect(submitButton()).toBeEnabled();
  });

  it('still accepts a full post link and prepends https to a schemeless linkedin.com paste', async () => {
    const { user } = await openLink();
    await user.type(screen.getByPlaceholderText('Paste a LinkedIn post URL'), 'www.linkedin.com/feed/update/urn:li:activity:7100000000000000001');
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0]!.body!.scope.postUrl).toBe('https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001');
  });

  it('rejects a link that is not a post with a reason that names the short link', async () => {
    const { user } = await openLink();
    const box = screen.getByPlaceholderText('Paste a LinkedIn post URL');
    await user.type(box, 'https://lnkd.in/ab/cd');
    expect(submitButton()).toBeDisabled();
    expect(box).toHaveAttribute('aria-invalid', 'true');
    const reason = document.getElementById('lead-capture-reason')!;
    expect(reason).toHaveTextContent('This does not look like a LinkedIn post. Use a link such as');
    expect(reason).toHaveTextContent('lnkd.in short link');
    await user.clear(box);
    await user.type(box, 'https://example.com/post');
    expect(submitButton()).toBeDisabled();
  });

  it('disables the button with a connectors link when Apify is not connected', async () => {
    world.apify = 'missing';
    const { user } = renderCard();
    await user.type(screen.getByPlaceholderText('Paste a LinkedIn post URL'), 'https://lnkd.in/abc');
    const reason = await screen.findByText(/to capture leads\./);
    expect(within(reason).getByRole('link', { name: 'Connect Apify in Settings' })).toHaveAttribute('href', '/settings/connectors');
    expect(submitButton()).toBeDisabled();
  });

  it('keeps its own enrichment default when the mode is switched back and forth', async () => {
    const { user } = await openLink();
    expect(enrichToggle()).toBeChecked();
    await user.click(modeButton('Pasted text'));
    expect(enrichToggle()).not.toBeChecked();
    await user.click(modeButton('Post link'));
    expect(enrichToggle()).toBeChecked();
  });
});

describe('import review source line', () => {
  const counts = { fetched: 3, staged: 3, duplicates: 0, invalid: 0 };

  function renderReview(extra: Record<string, unknown>) {
    const payload = { batchId: 'imp_1', actors: {}, counts, sample: [{ name: 'Ben Marsh', email: null, company: 'Harbor Row', title: 'Principal', linkedinUrl: null, kind: 'person' }], ...extra };
    const review = parseImportReviewPayload(payload)!;
    const approval = { id: 'apr_1', runId: 'run_1', kind: 'import_review', status: 'pending', payload } as unknown as Approval;
    render(
      <Router>
        <ImportReviewBody approval={approval} review={review} />
      </Router>,
    );
  }

  it('says a pasted capture came from pasted post text', () => {
    renderReview({ pasted: true });
    expect(screen.getByText('From pasted post text')).toBeInTheDocument();
    expect(screen.queryByText(/From a LinkedIn post/)).not.toBeInTheDocument();
  });

  it('adds the link when a pasted capture was given one', () => {
    renderReview({ pasted: true, postUrl: 'https://www.linkedin.com/posts/jane-doe_topic-activity-7100000000000000001-AbCd' });
    const line = screen.getByText(/From pasted post text/);
    expect(line).toHaveTextContent('From pasted post text https://www.linkedin.com/posts/jane-doe_topic-activity-7100000000000000001-AbCd');
  });

  it('shows the resolved post link for a capture that resolved a short link', () => {
    renderReview({
      originalUrl: 'https://lnkd.in/aBc-12_3',
      postUrl: 'https://www.linkedin.com/posts/jane-doe_topic-activity-7100000000000000001-AbCd',
    });
    const line = screen.getByText(/From a LinkedIn post/);
    expect(line).toHaveTextContent('From a LinkedIn post https://www.linkedin.com/posts/jane-doe_topic-activity-7100000000000000001-AbCd');
    expect(screen.queryByText(/lnkd\.in/)).not.toBeInTheDocument();
  });
});
