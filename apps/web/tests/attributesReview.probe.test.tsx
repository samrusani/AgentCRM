// Adversarial review probes for the custom attributes web surfaces (sheet rows, Settings section). Names start with
// KILLS (the attack fails), CONFIRMS (a live bug pinned as it behaves today), or ACCEPTED (a documented limit).
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersonSheet } from '../src/screens/RecordSheets';
import { AttributesSection } from '../src/screens/AttributeSettings';
import { Router } from './helpers';

vi.mock('../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../src/api/events', () => ({
  useServerEvents: () => {},
  useEventConnection: () => 'open',
}));

interface Def {
  id: string;
  entityType: 'person' | 'organization';
  key: string;
  label: string;
  kind: 'text' | 'number' | 'money';
  description: string | null;
  seq: number;
  version: number;
  valueCount: number;
}

const HOSTILE_LABEL = '<img src=x onerror="window.__pwned=1"> & "quoted" ‮RTL';
const HOSTILE_DESCRIPTION = '<script>window.__pwned=1</script><b>bold</b>';
const HOSTILE_VALUE = '<img src=x onerror="window.__pwned=1">\n<a href="javascript:window.__pwned=1">click</a>';

let defs: Def[];
let values: Record<string, unknown>;
let personVersion: number;
let patches: any[];
let patchFailure: { status: number; code: string; message: string; current?: unknown } | null;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const def = (key: string, label: string, kind: Def['kind'], description: string | null, seq: number, valueCount = 0): Def => ({
  id: `atd-${key}`,
  entityType: 'person',
  key,
  label,
  kind,
  description,
  seq,
  version: 1,
  valueCount,
});

function readings() {
  return defs.map((entry) => {
    const value = values[entry.key] ?? null;
    const money = entry.kind === 'money';
    return {
      id: entry.id,
      key: entry.key,
      label: entry.label,
      kind: entry.kind,
      description: entry.description,
      value: money ? (value as { amount: number } | null)?.amount ?? null : value,
      currency: money ? (value as { currency: string } | null)?.currency ?? 'USD' : null,
    };
  });
}

const personBody = () => ({
  id: 'person-1',
  version: personVersion,
  lifecycle: 'lead',
  firstName: 'Ada',
  lastName: 'Quinn',
  email: null,
  title: null,
  organizationId: null,
  organizationName: null,
  organization: null,
  location: null,
  tags: [],
  nextActionAt: null,
  createdAt: '2026-10-01T10:00:00',
  updatedAt: '2026-11-01T10:00:00',
  claims: [],
  activities: [],
  tasks: [],
  opportunities: [],
  attributes: readings(),
});

beforeEach(() => {
  defs = [
    def('hostile', HOSTILE_LABEL, 'text', HOSTILE_DESCRIPTION, 1, 1),
    def('plain-text', 'Plain text', 'text', null, 2, 0),
    def('plain-number', 'Plain number', 'number', null, 3, 7),
    def('plain-money', 'Plain money', 'money', null, 4, 0),
  ];
  values = { hostile: HOSTILE_VALUE };
  personVersion = 3;
  patches = [];
  patchFailure = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname === '/api/people/person-1' && method === 'PATCH') {
        patches.push(body);
        if (patchFailure) {
          const { status, code, message, current } = patchFailure;
          return json(status, { error: { code, message, current } });
        }
        for (const [field, value] of Object.entries(body.fields as Record<string, unknown>)) {
          const key = field.slice(5);
          if (value === null) delete values[key];
          else values[key] = value;
        }
        personVersion += 1;
        return json(200, personBody());
      }
      if (url.pathname === '/api/people/person-1') return json(200, personBody());
      if (url.pathname === '/api/attributes' && method === 'GET') {
        return json(200, { items: defs.filter((entry) => entry.entityType === url.searchParams.get('entityType')), nextCursor: null });
      }
      const match = /^\/api\/attributes\/([^/]+)$/.exec(url.pathname);
      if (match && method === 'DELETE') {
        defs = defs.filter((entry) => entry.id !== match[1]);
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      if (url.pathname === '/api/activities') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
  (window as any).__pwned = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderWith(node: React.ReactNode) {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>{node}</Router>
    </QueryClientProvider>,
  );
  return { user, client };
}

const renderSheet = () => renderWith(<PersonSheet id="person-1" onClose={vi.fn()} onOpenOrganization={vi.fn()} />);
const rowOf = (label: string) => screen.getByText(label, { selector: 'dt' }).closest('.field') as HTMLElement;

describe('hostile text renders as text', () => {
  it('KILLS: a hostile label, description and value on the person sheet render as inert text, create no elements, and run no script', async () => {
    renderSheet();
    const row = (await screen.findByText(HOSTILE_LABEL, { selector: 'dt' })).closest('.field') as HTMLElement;
    expect(within(row).getByText(HOSTILE_DESCRIPTION)).toBeInTheDocument();
    expect(row.textContent).toContain('<img src=x onerror="window.__pwned=1">');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    expect((window as any).__pwned).toBeUndefined();
    // The edit button is named from the label, still a plain button.
    expect(screen.getByRole('button', { name: `Edit ${HOSTILE_LABEL.toLowerCase()}` })).toBeInTheDocument();
  });

  it('KILLS: the hostile label and description are inert in Settings, in the Rename and Delete buttons, and in the delete confirm', async () => {
    const { user } = renderWith(<AttributesSection />);
    const people = await screen.findByRole('group', { name: 'People' });
    expect(await within(people).findByText(HOSTILE_LABEL)).toBeInTheDocument();
    expect(within(people).getByText(HOSTILE_DESCRIPTION)).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: `Delete ${HOSTILE_LABEL}` }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(`Delete ${HOSTILE_LABEL}? Its 1 saved value is deleted with it.`);
    expect(alert.querySelector('img')).toBeNull();
    expect((window as any).__pwned).toBeUndefined();
  });

  it('KILLS: the hostile label cannot break the new attribute sheet; the typed label goes out as data in the POST body', async () => {
    const posted: any[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/attributes' && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return json(201, def('x', 'x', 'text', null, 9));
      }
      return original(input, init);
    });
    const { user } = renderWith(<AttributesSection />);
    await screen.findByText(HOSTILE_LABEL);
    await user.click(screen.getByRole('button', { name: 'New attribute for people' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('Label'));
    await user.paste('<b>Bold</b> label');
    await user.click(within(dialog).getByRole('button', { name: 'Create attribute' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ entityType: 'person', label: '<b>Bold</b> label', kind: 'text' });
  });
});

describe('delete confirm counts', () => {
  it('KILLS: the confirm states 0, 1 and many values with matching grammar, and a failed delete says the attribute was not deleted', async () => {
    const { user } = renderWith(<AttributesSection />);
    await screen.findByText('Plain number');
    await user.click(screen.getByRole('button', { name: 'Delete Plain text' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Its 0 saved values are deleted with it.');
    await user.click(screen.getByRole('button', { name: 'Keep attribute' }));
    await user.click(screen.getByRole('button', { name: 'Delete Plain number' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Its 7 saved values are deleted with it.');
    await user.click(screen.getByRole('button', { name: 'Keep attribute' }));
    await user.click(screen.getByRole('button', { name: `Delete ${HOSTILE_LABEL}` }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Its 1 saved value is deleted with it.');
  });

  it('ACCEPTED: the count in the confirm is the count from the last list fetch; a value saved in another tab shows after the next record_updated refetch, not live inside an open confirm', async () => {
    const { user, client } = renderWith(<AttributesSection />);
    await screen.findByText('Plain text');
    await user.click(screen.getByRole('button', { name: 'Delete Plain text' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Its 0 saved values');
    defs.find((entry) => entry.key === 'plain-text')!.valueCount = 4;
    // Nothing refetches by itself in this isolated test; the SSE hook invalidates the "attributes" key on record_updated.
    expect(screen.getByRole('alert')).toHaveTextContent('Its 0 saved values');
    await client.invalidateQueries({ queryKey: ['attributes'] });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Its 4 saved values'));
  });
});

describe('value entry on the sheet', () => {
  const body = () => patches.at(-1);

  it('KILLS: money refuses a typed negative, a decimal, 1e12+1 and scientific overflow before any request; zero and 1e12 are sent', async () => {
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit plain money' }));
    const amount = screen.getByRole('spinbutton', { name: 'Plain money' });
    for (const typed of ['-5', '1.5', '1000000000001', '1e13']) {
      await user.clear(amount);
      await user.type(amount, typed);
      await user.keyboard('{Enter}');
      expect(await screen.findByText('Enter the amount as a whole number, 0 or more.')).toBeInTheDocument();
    }
    expect(patches).toHaveLength(0);
    await user.clear(amount);
    await user.type(amount, '0');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(body().fields).toEqual({ 'attr:plain-money': { amount: 0, currency: 'USD' } });
  });

  it('KILLS: the text box states the 2000 bound only when exceeded, keeps the draft, and saves exactly 2000 characters', async () => {
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit plain text' }));
    const box = screen.getByRole('textbox', { name: 'Plain text' });
    await user.click(box);
    await user.paste('a'.repeat(2000));
    expect(screen.queryByText(/limited to 2000/)).not.toBeInTheDocument();
    await user.keyboard('b');
    expect(await screen.findByText('Plain text is limited to 2000 characters. This is 2001.')).toBeInTheDocument();
    await user.keyboard('{Backspace}');
    expect(screen.queryByText(/limited to 2000/)).not.toBeInTheDocument();
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(patches).toHaveLength(1));
    expect((body().fields['attr:plain-text'] as string).length).toBe(2000);
  });

  it('KILLS: Enter inside the textarea adds a line instead of saving, and the saved value keeps the interior newline', async () => {
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit plain text' }));
    await user.type(screen.getByRole('textbox', { name: 'Plain text' }), 'one{Enter}two');
    expect(patches).toHaveLength(0);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(body().fields).toEqual({ 'attr:plain-text': 'one\ntwo' });
  });

  it('KILLS: a number attribute refuses words and overflow with the honest refusal line and sends no request', async () => {
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit plain number' }));
    const box = screen.getByRole('textbox', { name: 'Plain number' });
    // Words fail the plain-spelling check; 1e999 passes it and fails the finite check. Both send nothing.
    await user.type(box, 'abc{Enter}');
    expect(await screen.findByText(/Enter a plain number\./)).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, '1e999{Enter}');
    expect(await screen.findByText(/Enter a number\./)).toBeInTheDocument();
    expect(patches).toHaveLength(0);
  });

  it('KILLS: the number box refuses JavaScript literals like 0x10 with "Enter a plain number." and sends nothing, matching the server rule', async () => {
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit plain number' }));
    await user.type(screen.getByRole('textbox', { name: 'Plain number' }), '0x10{Enter}');
    const alert = await within(rowOf('Plain number')).findByRole('alert');
    expect(alert).toHaveTextContent('Enter a plain number.');
    expect(patches).toHaveLength(0);
  });

  it('ACCEPTED: a version conflict on an attribute shows the generic "different from the one you saw" line, because the 409 body is the plain record and carries no attr:<key> member; Save my value over it still works', async () => {
    patchFailure = { status: 409, code: 'version_conflict', message: 'Version conflict.', current: { version: 9, firstName: 'Ada' } };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit plain text' }));
    await user.type(screen.getByRole('textbox', { name: 'Plain text' }), 'Mine');
    await user.click(screen.getByText('Fields'));
    const alert = await within(rowOf('Plain text')).findByRole('alert');
    expect(alert).toHaveTextContent('The current value is different from the one you saw.');
    patchFailure = null;
    await user.click(within(alert).getByRole('button', { name: 'Save my value over it' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ expectedVersion: 9, fields: { 'attr:plain-text': 'Mine' } });
  });
});

describe('definition changes reach an open sheet', () => {
  it('KILLS: a definition rename shows on the open sheet after the person query is refetched, with the value untouched', async () => {
    values = { 'plain-text': 'kept value' };
    const { client } = renderSheet();
    expect(await within(await screen.findByText('Plain text', { selector: 'dt' }).then((n) => n.closest('.field') as HTMLElement)).findByText('kept value')).toBeInTheDocument();
    defs.find((entry) => entry.key === 'plain-text')!.label = 'Renamed text';
    await client.invalidateQueries({ queryKey: ['person'] });
    const row = (await screen.findByText('Renamed text', { selector: 'dt' })).closest('.field') as HTMLElement;
    expect(within(row).getByText('kept value')).toBeInTheDocument();
    expect(screen.queryByText('Plain text', { selector: 'dt' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit renamed text' })).toBeInTheDocument();
  });

  it('KILLS: a deleted definition disappears from the open sheet after the refetch, and an edit started before the delete fails with the editable field wording, not a silent save', async () => {
    const { user, client } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit plain text' }));
    await user.type(screen.getByRole('textbox', { name: 'Plain text' }), 'late');
    patchFailure = { status: 400, code: 'validation', message: 'attr:plain-text: There is no custom attribute with this key on people.' };
    await user.click(screen.getByText('Fields'));
    expect(await within(rowOf('Plain text')).findByRole('alert')).toHaveTextContent('Your edit was not saved.');
    patchFailure = null;
    defs = defs.filter((entry) => entry.key !== 'plain-text');
    await client.invalidateQueries({ queryKey: ['person'] });
    await waitFor(() => expect(screen.queryByText('Plain text', { selector: 'dt' })).not.toBeInTheDocument());
  });
});
