import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersonSheet } from '../../src/screens/RecordSheets';
import { AttributesSection } from '../../src/screens/AttributeSettings';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({
    setSelectedRecord: () => {},
    pushToast: () => {},
    toasts: [],
    dismissToast: () => {},
  }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../../src/api/events', () => ({
  useServerEvents: () => {},
  useEventConnection: () => 'open',
}));

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
}

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

let calls: Call[];
let defs: Def[];
// Person values by key: text and number as written, money as { amount, currency }.
let values: Record<string, unknown>;
let personVersion: number;
let patchFailure: { status: number; code: string; message: string; current?: unknown } | null;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const def = (key: string, label: string, kind: Def['kind'], description: string | null, seq: number, valueCount = 0, entityType: Def['entityType'] = 'person'): Def => ({
  id: `atd-${entityType}-${key}`,
  entityType,
  key,
  label,
  kind,
  description,
  seq,
  version: 1,
  valueCount,
});

function seededDefs(): Def[] {
  return [
    def('message-angle', 'Message angle', 'text', 'The outreach angle to lead with for this person.', 1, 3),
    def('fit-notes', 'Fit notes', 'text', 'If and how this investor fits what you are raising for.', 2, 1),
    def('research-notes', 'Research notes', 'text', 'Free form research notes.', 3),
    def('minimum-check-size', 'Minimum check size', 'money', 'The smallest check this investor writes.', 4, 2),
    def('maximum-check-size', 'Maximum check size', 'money', 'The largest check this investor writes.', 5),
    def('funds-managed', 'Funds managed', 'number', null, 6),
    def('thesis', 'Thesis', 'text', null, 1, 0, 'organization'),
  ];
}

function readings() {
  return defs
    .filter((entry) => entry.entityType === 'person')
    .map((entry) => {
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

function personBody() {
  return {
    id: 'person-1',
    version: personVersion,
    lifecycle: 'lead',
    firstName: 'Ada',
    lastName: 'Quinn',
    email: null,
    title: 'Partner',
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
  };
}

beforeEach(() => {
  calls = [];
  defs = seededDefs();
  values = {};
  personVersion = 3;
  patchFailure = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, search: url.searchParams, body });
      if (url.pathname === '/api/people/person-1' && method === 'PATCH') {
        if (patchFailure) {
          const { status, code, message, current } = patchFailure;
          return json(status, { error: { code, message, current } });
        }
        for (const [field, value] of Object.entries(body.fields as Record<string, unknown>)) {
          if (!field.startsWith('attr:')) continue;
          const key = field.slice(5);
          if (value === null) delete values[key];
          else values[key] = typeof value === 'object' ? value : value;
        }
        personVersion += 1;
        return json(200, personBody());
      }
      if (url.pathname === '/api/people/person-1') return json(200, personBody());
      if (url.pathname === '/api/attributes' && method === 'GET') {
        const type = url.searchParams.get('entityType');
        return json(200, { items: defs.filter((entry) => entry.entityType === type), nextCursor: null });
      }
      if (url.pathname === '/api/attributes' && method === 'POST') {
        const created = def(String(body.label).toLowerCase().replace(/[^a-z0-9]+/g, '-'), body.label, body.kind, body.description ?? null, 9, 0, body.entityType);
        defs.push(created);
        return json(201, created);
      }
      const match = /^\/api\/attributes\/([^/]+)$/.exec(url.pathname);
      if (match && method === 'PATCH') {
        const target = defs.find((entry) => entry.id === match[1])!;
        Object.assign(target, body.fields, { version: target.version + 1 });
        return json(200, target);
      }
      if (match && method === 'DELETE') {
        defs = defs.filter((entry) => entry.id !== match[1]);
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      if (url.pathname === '/api/activities') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
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
  return { user };
}

const renderSheet = () => renderWith(<PersonSheet id="person-1" onClose={vi.fn()} onOpenOrganization={vi.fn()} />);
const patches = () => calls.filter((call) => call.method === 'PATCH' && call.path === '/api/people/person-1');
const rowOf = (label: string) => screen.getByText(label, { selector: 'dt' }).closest('.field') as HTMLElement;

describe('attribute rows on the person sheet', () => {
  it('renders the seeded rows after the built in rows, with descriptions as hints and Not set values', async () => {
    renderSheet();
    await screen.findByText('Message angle', { selector: 'dt' });
    const labels = Array.from(document.querySelectorAll('dt.field__label')).map((node) => node.textContent);
    expect(labels.indexOf('Lists')).toBeGreaterThan(-1);
    expect(labels.slice(labels.indexOf('Lists') + 1)).toEqual([
      'Message angle',
      'Fit notes',
      'Research notes',
      'Minimum check size',
      'Maximum check size',
      'Funds managed',
    ]);
    expect(within(rowOf('Message angle')).getByText('The outreach angle to lead with for this person.')).toHaveClass('muted');
    expect(within(rowOf('Message angle')).getByText('Not set')).toBeInTheDocument();
    expect(within(rowOf('Minimum check size')).getByText('Not set')).toBeInTheDocument();
    expect(within(rowOf('Funds managed')).getByText('Not set')).toBeInTheDocument();
    expect(within(rowOf('Funds managed')).queryByText(/./, { selector: '.field__hint' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit message angle' })).toBeInTheDocument();
  });

  it('edits text in a textarea, saving attr:<key> on blur with the current version, and Escape cancels', async () => {
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit fit notes' }));
    const box = screen.getByRole('textbox', { name: 'Fit notes' });
    expect(box.tagName).toBe('TEXTAREA');
    await user.type(box, 'Writes seed checks.{Enter}Warm intro via Sam.');
    // Escape cancels without a request.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Fit notes' })).not.toBeInTheDocument();
    expect(patches()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Edit fit notes' }));
    await user.type(screen.getByRole('textbox', { name: 'Fit notes' }), '  Writes seed checks.  ');
    await user.click(screen.getByText('Fields'));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.body).toEqual({ expectedVersion: 3, fields: { 'attr:fit-notes': 'Writes seed checks.' } });
    expect(await within(rowOf('Fit notes')).findByText('Writes seed checks.')).toBeInTheDocument();
  });

  it('clears a text value by sending null', async () => {
    values = { 'research-notes': 'Old notes.' };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit research notes' }));
    await user.clear(screen.getByRole('textbox', { name: 'Research notes' }));
    await user.click(screen.getByText('Fields'));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.body.fields).toEqual({ 'attr:research-notes': null });
    expect(await within(rowOf('Research notes')).findByText('Not set')).toBeInTheDocument();
  });

  it('states the character bound only when it is exceeded, and does not save an over long value', async () => {
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit message angle' }));
    const box = screen.getByRole('textbox', { name: 'Message angle' });
    expect(screen.queryByText(/limited to 2000/)).not.toBeInTheDocument();
    await user.click(box);
    await user.paste('a'.repeat(2001));
    expect(await screen.findByText('Message angle is limited to 2000 characters. This is 2001.')).toBeInTheDocument();
    await user.click(screen.getByText('Fields'));
    expect(patches()).toHaveLength(0);
  });

  it('edits money as an amount and currency and sends { amount, currency }', async () => {
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit minimum check size' }));
    const amount = screen.getByRole('spinbutton', { name: 'Minimum check size' });
    const currency = screen.getByRole('combobox', { name: 'Minimum check size currency' });
    expect(currency).toHaveValue('USD');
    await user.type(amount, '250000');
    await user.selectOptions(currency, 'GBP');
    // Moving between the amount and the currency does not save by itself.
    expect(patches()).toHaveLength(0);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.body).toEqual({ expectedVersion: 3, fields: { 'attr:minimum-check-size': { amount: 250000, currency: 'GBP' } } });
    expect(await within(rowOf('Minimum check size')).findByText("£250.0K")).toBeInTheDocument();
  });

  it('refuses a fractional money amount without a request, and clears with an empty amount', async () => {
    values = { 'maximum-check-size': { amount: 1000000, currency: 'EUR' } };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit maximum check size' }));
    const amount = screen.getByRole('spinbutton', { name: 'Maximum check size' });
    await user.clear(amount);
    await user.type(amount, '1.5');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Enter the amount as a whole number, 0 or more.')).toBeInTheDocument();
    expect(patches()).toHaveLength(0);
    await user.clear(amount);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.body.fields).toEqual({ 'attr:maximum-check-size': null });
  });

  it('sends a number attribute as a number', async () => {
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit funds managed' }));
    await user.type(screen.getByRole('textbox', { name: 'Funds managed' }), '3.5{Enter}');
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.body.fields).toEqual({ 'attr:funds-managed': 3.5 });
    expect(await within(rowOf('Funds managed')).findByText('3.5')).toBeInTheDocument();
  });

  it('uses the editable field wording when a save conflicts', async () => {
    patchFailure = { status: 409, code: 'version_conflict', message: 'Version conflict.', current: { version: 5 } };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit fit notes' }));
    await user.type(screen.getByRole('textbox', { name: 'Fit notes' }), 'Mine');
    await user.click(screen.getByText('Fields'));
    const alert = await within(rowOf('Fit notes')).findByRole('alert');
    expect(alert).toHaveTextContent('Fit notes changed since you opened this record.');
    expect(alert).toHaveTextContent('Your edit "Mine" was not saved.');
    expect(within(alert).getByRole('button', { name: 'Reload record' })).toBeInTheDocument();
    patchFailure = null;
    await user.click(within(alert).getByRole('button', { name: 'Save my value over it' }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]!.body).toEqual({ expectedVersion: 5, fields: { 'attr:fit-notes': 'Mine' } });
  });

  it('says the edit was not saved for any other failure', async () => {
    patchFailure = { status: 400, code: 'validation', message: 'attr:fit-notes: There is no custom attribute with this key on people.' };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit fit notes' }));
    await user.type(screen.getByRole('textbox', { name: 'Fit notes' }), 'Mine');
    await user.click(screen.getByText('Fields'));
    expect(await within(rowOf('Fit notes')).findByRole('alert')).toHaveTextContent('Your edit was not saved.');
  });
});

describe('Settings, custom attributes', () => {
  const group = (name: string) => screen.getByRole('group', { name });

  it('lists both groups with label, kind, and description', async () => {
    renderWith(<AttributesSection />);
    expect(await screen.findByText('Message angle')).toBeInTheDocument();
    const people = group('People');
    expect(within(people).getAllByRole('listitem')).toHaveLength(6);
    expect(within(people).getByText('The outreach angle to lead with for this person.')).toHaveClass('muted');
    const angle = within(people).getByText('Message angle').closest('li') as HTMLElement;
    expect(within(angle).getByText('Text')).toBeInTheDocument();
    const minimum = within(people).getByText('Minimum check size').closest('li') as HTMLElement;
    expect(within(minimum).getByText('Money')).toBeInTheDocument();
    const organizations = group('Organizations');
    expect(await within(organizations).findByText('Thesis')).toBeInTheDocument();
  });

  it('creates an attribute, stating that the kind cannot change', async () => {
    const { user } = renderWith(<AttributesSection />);
    await screen.findByText('Message angle');
    await user.click(screen.getByRole('button', { name: 'New attribute for organizations' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The kind cannot be changed after the attribute is created.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create attribute' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Label'), 'Assets under management');
    await user.click(within(dialog).getByRole('radio', { name: /Money/ }));
    await user.type(within(dialog).getByLabelText('Description (optional)'), 'Reported AUM.');
    await user.click(within(dialog).getByRole('button', { name: 'Create attribute' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const post = calls.find((call) => call.method === 'POST' && call.path === '/api/attributes')!;
    expect(post.body).toEqual({ entityType: 'organization', label: 'Assets under management', kind: 'money', description: 'Reported AUM.' });
    expect(await within(group('Organizations')).findByText('Assets under management')).toBeInTheDocument();
  });

  it('renames with the version from when the sheet opened, sending only label and description', async () => {
    const { user } = renderWith(<AttributesSection />);
    await user.click(await screen.findByRole('button', { name: 'Rename Fit notes' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Saved values stay as they are/)).toBeInTheDocument();
    const label = within(dialog).getByLabelText('Label');
    await user.clear(label);
    await user.type(label, 'Investor fit');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const patch = calls.find((call) => call.method === 'PATCH' && call.path === '/api/attributes/atd-person-fit-notes')!;
    expect(patch.body).toEqual({ expectedVersion: 1, fields: { label: 'Investor fit', description: 'If and how this investor fits what you are raising for.' } });
    expect(await within(group('People')).findByText('Investor fit')).toBeInTheDocument();
  });

  it('asks an inline confirm that states the value count, and deletes only after it', async () => {
    const { user } = renderWith(<AttributesSection />);
    await user.click(await screen.findByRole('button', { name: 'Delete Message angle' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Delete Message angle? Its 3 saved values are deleted with it.');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    // Keep puts the row actions back.
    await user.click(within(alert).getByRole('button', { name: 'Keep attribute' }));
    expect(screen.getByRole('button', { name: 'Delete Message angle' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Fit notes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Its 1 saved value is deleted with it.');
    await user.click(screen.getByRole('button', { name: 'Delete attribute' }));
    await waitFor(() => expect(within(group('People')).queryByText('Fit notes')).not.toBeInTheDocument());
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/api/attributes/atd-person-fit-notes']);
  });
});
