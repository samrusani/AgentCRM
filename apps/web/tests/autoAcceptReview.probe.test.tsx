// Adversarial review probes for the auto accept imports setting and the organization Domain link. Names start with
// CONFIRMS (the bug is real, the test passes because it is) or KILLS (a safety property holds). Nothing here changes
// application code.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useServerEvents } from '../src/api/events';
import { ApprovalCard } from '../src/components/approvals';
import { DomainLink } from '../src/components/record';
import type { Approval } from '../src/api/types';
import { domainHref } from '../src/lib/links';
import { OrganizationSheet } from '../src/screens/RecordSheets';
import { GeneralSettings } from '../src/screens/Settings';
import { Router } from './helpers';

vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {}, setSelectedRecord: () => {} }),
}));

interface Call {
  method: string;
  path: string;
  body: any;
}

interface World {
  autoAccept: unknown;
  getStatus: number;
  putMode: 'ok' | '500' | 'network';
  calls: Call[];
  organization: Record<string, any>;
  patchConflict: boolean;
  putGate: Promise<void> | null;
}

let world: World;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function freshWorld(): World {
  return {
    autoAccept: false,
    getStatus: 200,
    putMode: 'ok',
    calls: [],
    patchConflict: false,
    putGate: null,
    organization: {
      id: 'o1',
      version: 2,
      name: 'Acme',
      domain: 'acme.example.com',
      kind: 'company',
      location: null,
      linkedinUrl: null,
      tags: [],
      people: [],
      claims: [],
      activities: [],
      opportunities: [],
      createdAt: '2026-10-01T10:00:00',
      updatedAt: '2026-11-01T10:00:00',
    },
  };
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      world.calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/imports/settings' && method === 'GET') {
        return world.getStatus === 200 ? json(200, { autoAccept: world.autoAccept }) : json(world.getStatus, { error: { code: 'internal', message: 'Something went wrong on the server.' } });
      }
      if (url.pathname === '/api/imports/settings' && method === 'PUT') {
        if (world.putGate) await world.putGate;
        if (world.putMode === 'network') throw new TypeError('Failed to fetch');
        if (world.putMode === '500') return json(500, { error: { code: 'internal', message: 'Something went wrong on the server.' } });
        world.autoAccept = body.autoAccept;
        return json(200, { autoAccept: world.autoAccept });
      }
      if (url.pathname === '/api/organizations/o1' && method === 'GET') return json(200, world.organization);
      if (url.pathname === '/api/organizations/o1' && method === 'PATCH') {
        if (world.patchConflict) return json(409, { error: { code: 'conflict', message: 'An organization with this domain already exists.' } });
        world.organization = { ...world.organization, ...body.fields, version: world.organization.version + 1 };
        return json(200, world.organization);
      }
      if (url.pathname === '/api/organizations/o1/enrichment') return json(200, { run: null, suggestions: [] });
      if (url.pathname === '/api/connectors') return json(200, []);
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  world = freshWorld();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSettings(wrap: (children: React.ReactNode) => React.ReactNode = (children) => children) {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>{wrap(<GeneralSettings />)}</Router>
    </QueryClientProvider>,
  );
  return { user, client };
}

const toggleName = 'Auto accept imports';
const importsSection = () => screen.getByRole('heading', { name: 'Imports' }).closest('section') as HTMLElement;
const gets = () => world.calls.filter((call) => call.method === 'GET' && call.path === '/api/imports/settings').length;
const puts = () => world.calls.filter((call) => call.method === 'PUT').map((call) => call.body);

describe('the toggle', () => {
  it('KILLS: a failed save while turning the setting off leaves it shown on and says it did not change', async () => {
    world.autoAccept = true;
    world.putMode = '500';
    const { user } = renderSettings();
    const toggle = await screen.findByRole('checkbox', { name: toggleName });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(await within(importsSection()).findByRole('alert')).toHaveTextContent('The setting did not change.');
    expect(toggle).toBeChecked();
    expect(puts()).toEqual([{ autoAccept: false }]);
  });

  it('KILLS: an unreachable server on save leaves the toggle where it was and shows the same notice', async () => {
    world.putMode = 'network';
    const { user } = renderSettings();
    const toggle = await screen.findByRole('checkbox', { name: toggleName });
    await user.click(toggle);
    expect(await within(importsSection()).findByRole('alert')).toHaveTextContent('The setting did not change.');
    expect(toggle).not.toBeChecked();
  });

  it('KILLS: when the setting cannot be read there is no toggle to blind write, only an error with Retry', async () => {
    world.getStatus = 500;
    const { user } = renderSettings();
    expect(await within(importsSection()).findByText('Could not load import settings')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: toggleName })).toBeNull();
    world.getStatus = 200;
    world.autoAccept = true;
    await user.click(within(importsSection()).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('checkbox', { name: toggleName })).toBeChecked();
    expect(puts()).toEqual([]);
  });

  it('KILLS: any server value other than exactly true renders the toggle off', async () => {
    for (const odd of ['true', 1, 'on', null, [true], { autoAccept: true }]) {
      world = freshWorld();
      world.autoAccept = odd;
      installFetch();
      const { unmount } = render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Router>
            <GeneralSettings />
          </Router>
        </QueryClientProvider>,
      );
      expect(await screen.findByRole('checkbox', { name: toggleName })).not.toBeChecked();
      unmount();
    }
  });

  it('KILLS: the toggle is disabled while a save is in flight, so a second click sends no second write', async () => {
    let open!: () => void;
    world.putGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { user } = renderSettings();
    const toggle = await screen.findByRole('checkbox', { name: toggleName });
    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeDisabled());
    await user.click(toggle);
    expect(puts()).toEqual([{ autoAccept: true }]);
    open();
    await waitFor(() => expect(toggle).toBeChecked());
    expect(toggle).toBeEnabled();
    expect(puts()).toEqual([{ autoAccept: true }]);
  });

  it('KILLS: another tab turning the setting on reaches this tab through the record_updated refetch', async () => {
    class FakeEventSource {
      static CLOSED = 2;
      static instances: FakeEventSource[] = [];
      readyState = 1;
      listeners = new Map<string, Array<() => void>>();
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((message: MessageEvent<string>) => void) | null = null;
      constructor(public url: string) {
        FakeEventSource.instances.push(this);
      }
      addEventListener(name: string, listener: () => void) {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      }
      close() {}
      fire(name: string) {
        for (const listener of this.listeners.get(name) ?? []) listener();
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    function Harness({ children }: { children: React.ReactNode }) {
      useServerEvents();
      return <>{children}</>;
    }
    const { client } = renderSettings((children) => <Harness>{children}</Harness>);
    const toggle = await screen.findByRole('checkbox', { name: toggleName });
    expect(toggle).not.toBeChecked();
    expect(gets()).toBe(1);
    // Another tab saves the setting on. The server emits record_updated for import_settings.
    world.autoAccept = true;
    act(() => FakeEventSource.instances[0]!.fire('record_updated'));
    await waitFor(() => expect(gets()).toBeGreaterThan(1));
    await waitFor(() => expect(toggle).toBeChecked());
    void client;
  });
});

function decided(overrides: Partial<Approval>): Approval {
  return {
    id: 'a1',
    runId: 'r1',
    kind: 'import_review',
    title: 'Review 12 staged rows',
    payload: {},
    payloadHash: 'hash',
    status: 'approved',
    note: null,
    decidedAt: '2026-11-05T10:00:00Z',
    decidedBy: 'auto_accept',
    createdAt: '2026-11-05T09:59:00Z',
    ...overrides,
  };
}

function renderApproval(approval: Approval) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Router>
        <ApprovalCard approval={approval} />
      </Router>
    </QueryClientProvider>,
  );
}

describe('Auto accepted wording', () => {
  it('KILLS: only decided_by exactly auto_accept earns the wording, not users, the system, an agent, near misses, or an open approval', () => {
    for (const decidedBy of ['user', 'system', 'agent:mcp', null, 'AUTO_ACCEPT', 'auto_accept ', 'auto-accept', 'auto_accepted']) {
      renderApproval(decided({ decidedBy }));
      expect(screen.queryByText('Auto accepted'), String(decidedBy)).toBeNull();
      expect(screen.getByText('Approved')).toBeInTheDocument();
      document.body.innerHTML = '';
    }
    renderApproval(decided({ status: 'pending', decidedBy: null, decidedAt: null }));
    expect(screen.queryByText('Auto accepted')).toBeNull();
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeInTheDocument();
  });
});

describe('Domain link', () => {
  const hostile = [
    'javascript:alert(1)//acme.com',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'https://user:pass@acme.example.com',
    'https://evil.example@acme.example.com',
    'acme.example.com@evil.example',
    'acme.example.com\\@evil.example',
    'acme.example.com%2f@evil.example',
    'acme.example.com:8080',
    'acme.example.com.',
    '//evil.example',
    'https:///evil.example',
    'аpple.com',
    'ａcme.example.com',
    'acme.example.com\nevil.example',
    'acme .example.com',
    'acme.example.com\u0000',
    '<img src=x onerror=alert(1)>.com',
    '[::1]',
    '-acme.example.com',
    'acme-.example.com',
    'localhost',
  ];

  it('KILLS: a hostile stored domain never becomes a link with a script, user info, port, or non https target', () => {
    for (const value of hostile) {
      expect(domainHref(value), value).toBeNull();
      const { container, unmount } = render(<DomainLink value={value} />);
      expect(container.querySelector('a'), value).toBeNull();
      expect(container.textContent).toBe(value);
      unmount();
    }
  });

  it('KILLS: every link that is produced is plain https to a bare host, opens in a new tab with noopener, and keeps the stored text visible', () => {
    // Values carrying a scheme, path, or query render as plain text now (the contract's bare host
    // rule), so only genuinely bare hosts appear here.
    const accepted = ['xn--pple-43d.com', '  acme.example.com  ', 'Acme.Example.com'];
    const refused = [
      'HTTP://Acme.Example.com/about?x=1#frag',
      'acme.example.com/path',
      'https://acme.example.com?x=@evil.example',
      'javascript://acme.example.com',
    ];
    for (const value of refused) {
      const { container, unmount } = render(<DomainLink value={value} />);
      expect(container.querySelector('a'), value).toBeNull();
      unmount();
    }
    for (const value of accepted) {
      const { container, unmount } = render(<DomainLink value={value} />);
      const link = container.querySelector('a') as HTMLAnchorElement;
      expect(link, value).not.toBeNull();
      expect(link.getAttribute('href'), value).toMatch(/^https:\/\/[A-Za-z0-9.-]+$/);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(link.getAttribute('rel')).toContain('noreferrer');
      expect(link.textContent).toBe(value);
      unmount();
    }
  });

  it('KILLS: the trimmed bare host is what the produced link shows and targets', () => {
    const { container } = render(<DomainLink value="  acme.example.com  " />);
    const link = container.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://acme.example.com');
  });

  it('KILLS: a stored value shaped like a scheme with a dotted name renders as plain text, never a link to the other host', () => {
    const { container } = render(<DomainLink value="acme.example.com://evil.example" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('acme.example.com://evil.example');
  });

  it('KILLS: purely numeric hosts, loopback and private address spellings included, render as plain text', () => {
    for (const value of ['127.1', '0x7f.1', '10.1', '192.168.1', '169.254.169.254']) {
      expect(domainHref(value), value).toBeNull();
    }
  });

  it('KILLS: the Domain row stays editable, a duplicate domain answers 409 with the server message, the draft is kept, and no override is offered', async () => {
    const user = userEvent.setup();
    world.patchConflict = true;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Router>
          <OrganizationSheet id="o1" onClose={() => {}} onOpenPerson={() => {}} />
        </Router>
      </QueryClientProvider>,
    );
    await screen.findByRole('heading', { name: 'Fields' });
    const row = screen.getByText('Domain', { selector: 'dt' }).closest('.field') as HTMLElement;
    expect(within(row).getByRole('link', { name: 'acme.example.com' })).toHaveAttribute('href', 'https://acme.example.com');
    await user.click(within(row).getByRole('button', { name: 'Edit domain' }));
    const input = screen.getByRole('textbox', { name: 'Domain' });
    await user.clear(input);
    await user.type(input, 'taken.example.com{Enter}');
    const alert = await within(row).findByRole('alert');
    expect(alert).toHaveTextContent('An organization with this domain already exists.');
    expect(alert).toHaveTextContent('Your edit was not saved.');
    expect(within(alert).queryByRole('button', { name: 'Save my value over it' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Domain' })).toHaveValue('taken.example.com');
    expect(world.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });
});
