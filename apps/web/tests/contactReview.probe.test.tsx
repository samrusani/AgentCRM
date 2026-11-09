// Adversarial probes for the contact fields wave (web side), kept as regressions. Tests named KILL assert the behavior the
// contract wants and are marked it.fails while the defect stands; remove the marker when the fix lands.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { websiteHref, websiteLabel } from '../src/lib/links';
import { CsvImportSheet } from '../src/screens/CsvImportSheet';
import { Leads } from '../src/screens/Relationships';
import { OrganizationSheet, PersonSheet } from '../src/screens/RecordSheets';
import { Router } from './helpers';

vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {}, setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../src/api/events', () => ({ useServerEvents: () => {}, useEventConnection: () => 'open' }));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const hostile = [
  'javascript:alert(1)',
  'JAVASCRIPT:alert(1)',
  'JaVaScRiPt://x.com/%0aalert(1)',
  'javascript://example.com/%0Aalert(document.domain)',
  ' javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'blob:https://a.b/uuid',
  'file:///etc/passwd',
  'ftp://a.b.c',
  'https://',
  'http://',
  '//evil.example.com',
  'java\tscript:alert(1)',
  'javascript&colon;alert(1)',
  '\u0000javascript:alert(1)',
  'x'.repeat(500),
];

describe('8. websiteHref / websiteLabel never emit a non-http(s) href, even for legacy or hand-inserted values', () => {
  it('CONFIRM: sweep of hostile stored values', () => {
    for (const value of hostile) {
      const href = websiteHref(value);
      if (href !== null) expect(href, JSON.stringify(value)).toMatch(/^https?:\/\//);
      expect(typeof websiteLabel(value)).toBe('string');
    }
    expect(websiteHref('javascript:alert(1)')).toBeNull();
    expect(websiteHref('JAVASCRIPT://a.b/%0aalert(1)')).toBeNull();
    expect(websiteHref('https://')).toBeNull();
  });

  it('CONFIRM: labels drop the scheme and a leading www., keep the path, drop the trailing slash, never throw on junk', () => {
    expect(websiteLabel('https://www.acme.com/team/')).toBe('acme.com/team');
    expect(websiteLabel('HTTP://WWW.Acme.com')).toBe('acme.com');
    expect(websiteLabel('acme.com/a/b?x=1#y')).toBe('acme.com/a/b');
    expect(websiteLabel('https://')).toBe('https://');
    expect(websiteLabel('')).toBe('');
    expect(websiteLabel(null)).toBe('');
    expect(websiteLabel('https://user:pw@good.com/x')).toBe('good.com/x');
  });

  it('ACCEPTED: numeric/loopback hosts link (domainHref blocks them, websiteHref does not); a unicode host is labelled in punycode', () => {
    expect(websiteHref('https://127.0.0.1/admin')).toBe('https://127.0.0.1/admin');
    expect(websiteLabel('https://bücher.de/x')).toBe('xn--bcher-kva.de/x');
  });
});

describe('8b. sheets and the org table render hostile stored values harmlessly', () => {
  let phone: string | null = null;
  let website: string | null = null;
  let patches: any[] = [];
  const common = { version: 2, claims: [], activities: [], tasks: [], opportunities: [], attributes: [], tags: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00' };
  const person = () => ({ ...common, id: 'person-1', lifecycle: 'lead', firstName: 'Ada', lastName: 'Quinn', email: null, title: null, organizationId: null, organizationName: null, organization: null, location: 'Berlin', nextActionAt: null, phone, website });
  const org = (id = 'org-1', site: string | null = website) => ({ ...common, id, name: 'Acme Capital', domain: null, kind: 'fund', location: 'Berlin', people: [], phone, website: site });
  let orgList: any[] = [];

  beforeEach(() => {
    phone = null;
    website = null;
    patches = [];
    orgList = [];
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        if ((init?.method ?? 'GET') === 'PATCH') {
          patches.push(JSON.parse(String(init!.body)));
          return json(200, person());
        }
        if (url.pathname === '/api/people/person-1') return json(200, person());
        if (url.pathname === '/api/organizations/org-1') return json(200, org());
        if (url.pathname === '/api/organizations') return json(200, { items: orgList, nextCursor: null });
        if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
        return json(200, { items: [], nextCursor: null });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  });

  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const anchorsWithBadHref = () =>
    Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href') ?? '')
      .filter((href) => !/^(https?:\/\/|\/|#|mailto:)/i.test(href));

  for (const kind of ['person', 'organization'] as const) {
    it(`CONFIRM: ${kind} sheet shows legacy junk as plain text with no unsafe anchor, and the junk can be edited away`, async () => {
      for (const value of hostile.filter((v) => v.trim() !== '' && !v.includes('\u0000'))) {
        website = value;
        phone = 'none';
        const view = render(
          <QueryClientProvider client={client()}>
            <Router>
              {kind === 'person' ? <PersonSheet id="person-1" onClose={() => {}} onOpenOrganization={() => {}} /> : <OrganizationSheet id="org-1" onClose={() => {}} onOpenPerson={() => {}} />}
            </Router>
          </QueryClientProvider>,
        );
        await screen.findByText('Berlin');
        expect(anchorsWithBadHref(), JSON.stringify(value)).toEqual([]);
        expect(screen.getByText('none')).toBeInTheDocument();
        view.unmount();
      }
    });

    it(`CONFIRM: ${kind} sheet: clearing a junk website sends null and the Website row stays editable`, async () => {
      website = 'javascript:alert(1)';
      const user = userEvent.setup();
      render(
        <QueryClientProvider client={client()}>
          <Router>
            {kind === 'person' ? <PersonSheet id="person-1" onClose={() => {}} onOpenOrganization={() => {}} /> : <OrganizationSheet id="org-1" onClose={() => {}} onOpenPerson={() => {}} />}
          </Router>
        </QueryClientProvider>,
      );
      await screen.findByText('javascript:alert(1)');
      const term = screen.getAllByText('Website').find((e) => e.tagName === 'DT')!;
      await user.click(within(term.parentElement as HTMLElement).getByRole('button', { name: 'Edit website' }));
      const input = screen.getByRole('textbox', { name: 'Website' });
      expect(input).toHaveValue('javascript:alert(1)');
      await user.clear(input);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(patches).toHaveLength(1));
      expect(patches[0]).toEqual({ expectedVersion: 2, fields: { website: null } });
    });
  }

  it('CONFIRM: 40/500 client limits: a 501 character website and 41 character phone are held back with the limit message, nothing is sent', async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client()}>
        <Router>
          <PersonSheet id="person-1" onClose={() => {}} onOpenOrganization={() => {}} />
        </Router>
      </QueryClientProvider>,
    );
    await screen.findByText('Berlin');
    const rowOf = (label: string) => screen.getAllByText(label).find((e) => e.tagName === 'DT')!.parentElement as HTMLElement;
    await user.click(within(rowOf('Phone')).getByRole('button', { name: 'Edit phone' }));
    await user.click(screen.getByRole('textbox', { name: 'Phone' }));
    await user.paste('5'.repeat(41));
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/limited to 40 characters/)).toBeInTheDocument();
    expect(patches).toHaveLength(0);
    await user.keyboard('{Escape}');
    await user.click(within(rowOf('Website')).getByRole('button', { name: 'Edit website' }));
    await user.click(screen.getByRole('textbox', { name: 'Website' }));
    await user.paste('a.com/' + 'x'.repeat(495));
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/limited to 500 characters/)).toBeInTheDocument();
    expect(patches).toHaveLength(0);
  });

  it('CONFIRM: the sheet link for a 500 character value keeps a title attr with the full stored text', async () => {
    website = 'https://a.com/' + 'x'.repeat(486);
    render(
      <QueryClientProvider client={client()}>
        <Router>
          <OrganizationSheet id="org-1" onClose={() => {}} onOpenPerson={() => {}} />
        </Router>
      </QueryClientProvider>,
    );
    const link = await screen.findByRole('link', { name: /^a\.com\/x+/ });
    expect(link).toHaveAttribute('title', website);
  });

  it('CONFIRM: org table cells never produce an unsafe anchor for hostile values and an empty value is an empty cell', async () => {
    orgList = hostile.map((value, index) => ({ id: `org-h${index}`, version: 1, name: `Hostile ${index}`, domain: null, kind: 'company', location: null, linkedinUrl: null, website: value, tags: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00' }));
    orgList.push({ id: 'org-empty', version: 1, name: 'Empty One', domain: null, kind: 'company', location: null, linkedinUrl: null, website: null, tags: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00' });
    render(
      <QueryClientProvider client={client()}>
        <Router initialEntries={['/leads?tab=organizations']}>
          <Routes>
            <Route path="/leads" element={<Leads />} />
          </Routes>
        </Router>
      </QueryClientProvider>,
    );
    await screen.findByText('Hostile 0');
    expect(anchorsWithBadHref()).toEqual([]);
    expect(screen.getByText('Empty One')).toBeInTheDocument();
  });

  // KILL (low): the sheet link carries title={full stored value}; the table link does not, though the cell ellipsizes a long
  // host+path with no other way to read it (the LinkedIn column has the same gap, so this is consistent, but the wave brief
  // asks for truncation + title).
  it('KILL (low): the org table Website link has a title attr with the stored value', async () => {
    orgList = [{ id: 'org-t', version: 1, name: 'Titled Co', domain: null, kind: 'company', location: null, linkedinUrl: null, website: 'https://www.acme.com/a/very/long/path/to/team', tags: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00' }];
    render(
      <QueryClientProvider client={client()}>
        <Router initialEntries={['/leads?tab=organizations']}>
          <Routes>
            <Route path="/leads" element={<Leads />} />
          </Routes>
        </Router>
      </QueryClientProvider>,
    );
    const link = await screen.findByRole('link', { name: 'acme.com/a/very/long/path/to/team' });
    expect(link).toHaveAttribute('title', 'https://www.acme.com/a/very/long/path/to/team');
  });
});

describe('6b. CSV import sheet', () => {
  // KILL: the server suggests phone and website for matching headers (docs: "CSV import person mapping (suggested headers
  // phone and website)"), but the web mapping sheet has no Phone or Website option and its KNOWN_TARGETS filter turns the
  // suggestion into Ignore, so the user can neither keep the suggestion nor choose it.
  it('KILL: the CSV mapping sheet offers Phone and Website and keeps the server suggestion for those columns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/imports/csv/preview') {
          return json(200, {
            headers: ['Name', 'Phone', 'Website'],
            delimiter: ',',
            rowCount: 1,
            suggestedMapping: { Name: 'name', Phone: 'phone', Website: 'website' },
            sample: [['Pat', '555 0100', 'pat.example.com']],
          });
        }
        return json(200, { items: [], nextCursor: null });
      }),
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Router>
          <CsvImportSheet onClose={() => {}} onStaged={() => {}} />
        </Router>
      </QueryClientProvider>,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['Name,Phone,Website\nPat,555 0100,pat.example.com\n'], 'c.csv', { type: 'text/csv' }));
    await screen.findByText('555 0100');
    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[];
    expect(selects).toHaveLength(3);
    expect(selects.map((s) => s.value)).toEqual(['name', 'phone', 'website']);
    vi.unstubAllGlobals();
  });
});
