// Adversarial review probes for suggestion values that render as links. Names start with KILLS (a real defect, pinned
// with it.fails), CONFIRMS (an attack failed, a property holds), or ACCEPTED (an imperfection that is fine, with the
// why). Nothing here changes application code.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrganizationSheet, PersonSheet } from '../src/screens/RecordSheets';
import { Router } from './helpers';

vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
  useUI: () => ({ setSelectedRecord: () => {} }),
}));

interface Call {
  method: string;
  path: string;
}
let enrichment: { run: Record<string, unknown> | null; suggestions: Array<Record<string, unknown>> };
let calls: Call[];
let holdAccept: Promise<void> | null;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const base = { version: 3, email: null, title: null, location: null, linkedinUrl: null, tags: [], claims: [], activities: [], tasks: [], opportunities: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00' };
const person = { ...base, id: 'p1', firstName: 'Jane', lastName: 'Doe', organizationId: null, xUrl: null, nextActionAt: null, qualification: null, organization: null, affiliationsSummary: null };
const organization = { ...base, id: 'o1', name: 'Acme', domain: null, kind: 'company', people: [] };

beforeEach(() => {
  window.localStorage.clear();
  calls = [];
  holdAccept = null;
  enrichment = { run: null, suggestions: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: `${url.pathname}${url.search}` });
      if (url.pathname === '/api/people/p1' && method === 'GET') return json(200, person);
      if (url.pathname === '/api/organizations/o1' && method === 'GET') return json(200, organization);
      if (url.pathname.endsWith('/enrichment') && method === 'GET') return json(200, enrichment);
      if (url.pathname.endsWith('/enrichment')) {
        if (holdAccept) await holdAccept;
        return json(200, {});
      }
      if (url.pathname === '/api/connectors') return json(200, [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, allowlist: [] }]);
      if (url.pathname === '/api/model-provider') return json(200, { kind: 'anthropic', model: 'm', status: 'connected', statusMessage: null, ready: true });
      if (url.pathname === '/api/followup-rules') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function seed(suggestions: Array<{ field: string; value: string }>, mode = 'web') {
  enrichment = {
    run: { id: 'run-web', status: 'succeeded', startedAt: '2026-11-05T10:00:00', mode, detail: 'Done.', suggestedCount: suggestions.length },
    suggestions: suggestions.map((entry) => ({ ...entry, sourceUrl: null })),
  };
}

function renderSheet(kind: 'person' | 'org' = 'person') {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        {kind === 'person' ? <PersonSheet id="p1" onClose={() => {}} onOpenOrganization={() => {}} /> : <OrganizationSheet id="o1" onClose={() => {}} onOpenPerson={() => {}} />}
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

async function sectionFor(kind: 'person' | 'org' = 'person'): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: 'Suggestions' });
  void kind;
  return heading.closest('section') as HTMLElement;
}

async function valueOf(value: string, field = 'website') {
  seed([{ field, value }]);
  renderSheet();
  const section = await sectionFor();
  const row = section.querySelector('li.suggestion-row') as HTMLElement;
  const el = row.querySelector('.suggestion-row__value') as HTMLElement;
  return { section, row, el, anchor: row.querySelector('a') as HTMLAnchorElement | null };
}

describe('suggestion links: hostile schemes', () => {
  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://evil.example.net/uuid',
    '  javascript:alert(1)',
  ])('CONFIRMS: %s stays plain text with no anchor', async (value) => {
    const { anchor, el } = await valueOf(value);
    expect(anchor).toBeNull();
    expect(el.tagName).toBe('SPAN');
  });

  it('KILLS, fixed: a scheme-prefixed value with a numeric tail (javascript:1) must stay plain text, never gain https:// in front', async () => {
    const { anchor } = await valueOf('javascript:1');
    expect(anchor).toBeNull();
  });

  it('KILLS, fixed: mailto:jane@example.com must stay plain text, never link to a host the visible text does not name', async () => {
    const { anchor } = await valueOf('mailto:jane@example.com');
    expect(anchor).toBeNull();
  });

  it('CONFIRMS: a mailto value that does link at least never carries a javascript or mailto href', async () => {
    const { anchor } = await valueOf('mailto:jane@example.com');
    expect(anchor?.getAttribute('href') ?? 'https://').toMatch(/^https?:\/\//);
  });
});

describe('suggestion links: odd but parseable values', () => {
  it('ACCEPTED: a schemeless value (example.com) links to https://example.com/, exactly as the saved website and profile field rows do, and the text is the stored value', async () => {
    const { anchor, el } = await valueOf('example.com');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/');
    expect(el).toHaveTextContent(/^example\.com$/);
  });

  it('ACCEPTED: a protocol-relative value (//evil.example.net) links to https://evil.example.net/, whose host is the one the text names', async () => {
    const { anchor } = await valueOf('//evil.example.net');
    expect(new URL(anchor!.href).host).toBe('evil.example.net');
    expect(anchor!.href.startsWith('https://')).toBe(true);
  });

  it('ACCEPTED: four leading slashes still resolve to the named host over https (no other host can be reached)', async () => {
    const { anchor } = await valueOf('////evil.example.net');
    expect(new URL(anchor!.href).host).toBe('evil.example.net');
  });

  it('CONFIRMS: a padded value links to the trimmed URL and keeps the full stored text', async () => {
    const { anchor, el } = await valueOf('  https://acme.example.com/a  ');
    expect(anchor!.getAttribute('href')).toBe('https://acme.example.com/a');
    expect(el.textContent).toBe('  https://acme.example.com/a  ');
  });

  it('ACCEPTED: a newline inside the value is stripped by URL parsing, so the href joins the lines while the text shows two; the host is unchanged and the user still sees the target in the status bar', async () => {
    const { anchor } = await valueOf('https://acme.example.com/a\nb');
    expect(new URL(anchor!.href).host).toBe('acme.example.com');
  });

  it('ACCEPTED: userinfo (https://user@evil.example.net) links, host equals the parsed host, and the text shows the userinfo so nothing is hidden', async () => {
    const { anchor, el } = await valueOf('https://user@evil.example.net/x');
    expect(new URL(anchor!.href).host).toBe('evil.example.net');
    expect(el.textContent).toContain('user@');
  });

  it('CONFIRMS: an internationalised host links with the punycode host while the text keeps the stored value', async () => {
    const { anchor, el } = await valueOf('https://bücher.example/x');
    expect(new URL(anchor!.href).host).toBe('xn--bcher-kva.example');
    expect(el.textContent).toBe('https://bücher.example/x');
  });

  it('CONFIRMS: a 500 character url links in full and the text is not truncated', async () => {
    const value = `https://acme.example.com/${'a'.repeat(475)}`;
    expect(value).toHaveLength(500);
    const { anchor, el } = await valueOf(value);
    expect(anchor!.getAttribute('href')).toBe(value);
    expect(el.textContent).toBe(value);
  });

  it.each(['', '   '])('CONFIRMS: the empty or blank value %j renders a span, not an anchor', async (value) => {
    const { anchor, el } = await valueOf(value);
    expect(anchor).toBeNull();
    expect(el.tagName).toBe('SPAN');
  });

  it('CONFIRMS: the anchor has no title attribute and its host equals the parsed value host', async () => {
    const { anchor } = await valueOf('https://www.Acme.example.com:8443/path?q=1#f');
    expect(anchor!.hasAttribute('title')).toBe(false);
    expect(anchor!.host).toBe(new URL('https://www.Acme.example.com:8443/path?q=1#f').host);
    expect(anchor!.getAttribute('target')).toBe('_blank');
    expect(anchor!.getAttribute('rel')).toBe('noreferrer noopener');
  });
});

describe('suggestion links: markup in the text', () => {
  it('CONFIRMS: entities and an img onerror payload in a link value render escaped inside one anchor, no element injected', async () => {
    const value = 'https://x.example.com/?a=&amp;b=<img src=x onerror=alert(1)>&lt;script&gt;';
    const { section, anchor } = await valueOf(value);
    expect(section.querySelector('img, script')).toBeNull();
    expect(anchor!.children).toHaveLength(0);
    expect(anchor!.textContent).toBe(value);
    expect(section.querySelectorAll('a')).toHaveLength(1);
  });

  it('CONFIRMS: markup in an unparseable link value renders as text in a span', async () => {
    const value = '<a href="https://evil.example.net">x</a> <img src=x onerror=alert(1)>';
    const { section, el } = await valueOf(value);
    expect(section.querySelector('img')).toBeNull();
    expect(section.querySelector('a')).toBeNull();
    expect(el.tagName).toBe('SPAN');
    expect(el.textContent).toBe(value);
  });
});

describe('suggestion links: non-link fields', () => {
  it('CONFIRMS: title, location and email values shaped like URLs never link', async () => {
    seed([
      { field: 'title', value: 'https://evil.example.net' },
      { field: 'location', value: 'https://evil.example.net/loc' },
      { field: 'email', value: 'https://evil.example.net/e' },
    ]);
    renderSheet();
    const section = await sectionFor();
    expect(section.querySelectorAll('li.suggestion-row')).toHaveLength(3);
    expect(section.querySelector('a')).toBeNull();
  });

  it('CONFIRMS: a field outside the known set (domain and junk names) stays plain whatever its value', async () => {
    seed([
      { field: 'domain', value: 'https://evil.example.net' },
      { field: 'websiteUrl', value: 'https://evil.example.net/1' },
      { field: 'Website', value: 'https://evil.example.net/2' },
      { field: 'size', value: 'https://evil.example.net/3' },
    ]);
    renderSheet();
    const section = await sectionFor();
    expect(section.querySelectorAll('li.suggestion-row').length).toBeGreaterThan(0);
    expect(section.querySelector('a')).toBeNull();
  });
});

describe('suggestion links: interaction', () => {
  it('CONFIRMS: tab order is the anchor, then Accept, then Dismiss', async () => {
    seed([{ field: 'website', value: 'https://acme.example.com' }]);
    const { user } = renderSheet();
    const anchor = await screen.findByRole('link', { name: 'https://acme.example.com' });
    const accept = screen.getByRole('button', { name: 'Accept website' });
    const dismiss = screen.getByRole('button', { name: 'Dismiss website' });
    anchor.focus();
    expect(anchor).toHaveFocus();
    await user.tab();
    expect(accept).toHaveFocus();
    await user.tab();
    expect(dismiss).toHaveFocus();
  });

  it('CONFIRMS: clicking the anchor sends no mutation request', async () => {
    seed([{ field: 'website', value: 'https://acme.example.com' }]);
    const { user } = renderSheet();
    const anchor = await screen.findByRole('link', { name: 'https://acme.example.com' });
    anchor.addEventListener('click', (event) => event.preventDefault());
    const before = calls.length;
    await user.click(anchor);
    expect(calls.slice(before).filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('ACCEPTED: while an accept is in flight the Accept and Dismiss buttons are disabled but the anchor stays a live, enabled link; a link is not a control and opening it changes nothing', async () => {
    seed([{ field: 'website', value: 'https://acme.example.com' }]);
    let release!: () => void;
    holdAccept = new Promise<void>((resolve) => (release = resolve));
    const { user } = renderSheet();
    const anchor = await screen.findByRole('link', { name: 'https://acme.example.com' });
    await user.click(screen.getByRole('button', { name: 'Accept website' }));
    expect(await screen.findByRole('button', { name: 'Dismiss website' })).toBeDisabled();
    expect(anchor).toHaveAttribute('href', 'https://acme.example.com/');
    expect(anchor).not.toHaveAttribute('aria-disabled');
    expect(anchor).not.toHaveAttribute('tabindex');
    release();
  });
});

describe('suggestion links: organization flow', () => {
  it('CONFIRMS: an organization linkedinUrl suggestion links and its domain suggestion stays plain', async () => {
    seed(
      [
        { field: 'linkedinUrl', value: 'https://www.linkedin.com/company/acme' },
        { field: 'domain', value: 'https://acme.example.com' },
      ],
      'org',
    );
    renderSheet('org');
    const section = await sectionFor('org');
    const anchors = section.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toHaveAttribute('href', 'https://www.linkedin.com/company/acme');
    expect(anchors[0]).toHaveAttribute('rel', 'noreferrer noopener');
    const domainRow = screen.getByRole('button', { name: 'Accept domain' }).closest('li')!;
    expect(domainRow.querySelector('a')).toBeNull();
    expect(domainRow.querySelector('.suggestion-row__value')!.tagName).toBe('SPAN');
  });
});
