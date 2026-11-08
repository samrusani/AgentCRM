import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AutomationsSection } from '../../src/screens/AutomationSettings';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
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
  body: any;
}

interface Rule {
  id: string;
  name: string;
  triggerKind: 'stage_entered' | 'person_promoted';
  triggerConfig: { pipelineId?: string; stageId?: string };
  actionConfig: { taskTitle: string; dueInDays: number };
  enabled: boolean;
  disabledReason: string | null;
  firedCount: number;
  version: number;
}

let calls: Call[];
let rules: Rule[];
let failure: { status: number; code: string; message: string } | null;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const pipelines = [
  {
    id: 'pip-fund',
    name: 'Fundraising',
    template: 'startup-fundraising',
    version: 1,
    stages: [
      { id: 'stg-fund-1', pipelineId: 'pip-fund', name: 'Research', seq: 1 },
      { id: 'stg-fund-2', pipelineId: 'pip-fund', name: 'Diligence', seq: 2 },
    ],
  },
  {
    id: 'pip-sales',
    name: 'Sales',
    template: 'client-sales',
    version: 1,
    stages: [
      { id: 'stg-sales-1', pipelineId: 'pip-sales', name: 'Discovery', seq: 1 },
      { id: 'stg-sales-2', pipelineId: 'pip-sales', name: 'Proposal', seq: 2 },
    ],
  },
];

const rule = (overrides: Partial<Rule> & Pick<Rule, 'id' | 'name'>): Rule => ({
  triggerKind: 'stage_entered',
  triggerConfig: { pipelineId: 'pip-fund', stageId: 'stg-fund-2' },
  actionConfig: { taskTitle: 'Prepare for {name}', dueInDays: 2 },
  enabled: true,
  disabledReason: null,
  firedCount: 0,
  version: 1,
  ...overrides,
});

beforeEach(() => {
  calls = [];
  failure = null;
  rules = [
    rule({ id: 'aut-1', name: 'Diligence prep', firedCount: 3 }),
    rule({
      id: 'aut-2',
      name: 'Welcome',
      triggerKind: 'person_promoted',
      triggerConfig: {},
      actionConfig: { taskTitle: 'Say hello to {name}', dueInDays: 0 },
      firedCount: 1,
    }),
    rule({
      id: 'aut-3',
      name: 'Orphan',
      triggerConfig: { pipelineId: 'pip-gone', stageId: 'stg-gone' },
      actionConfig: { taskTitle: 'Orphan {name}', dueInDays: 1 },
      enabled: false,
      disabledReason: 'The pipeline "Old pipeline" this rule named was deleted.',
    }),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/pipelines') return json(200, { items: pipelines, nextCursor: null });
      if (url.pathname === '/api/automations' && method === 'GET') return json(200, { items: rules, nextCursor: null });
      if (method !== 'GET' && failure) return json(failure.status, { error: { code: failure.code, message: failure.message } });
      if (url.pathname === '/api/automations' && method === 'POST') {
        const created = rule({ id: 'aut-new', name: body.name, triggerKind: body.triggerKind, triggerConfig: body.triggerConfig, actionConfig: body.actionConfig });
        rules = [created, ...rules];
        return json(201, created);
      }
      const match = /^\/api\/automations\/([^/]+)$/.exec(url.pathname);
      if (match && method === 'PATCH') {
        const target = rules.find((entry) => entry.id === match[1])!;
        Object.assign(target, body.fields, { version: target.version + 1 });
        if (body.fields.enabled === true || body.fields.triggerConfig) target.disabledReason = null;
        return json(200, target);
      }
      if (match && method === 'DELETE') {
        rules = rules.filter((entry) => entry.id !== match[1]);
        return new Response(null, { status: 204 });
      }
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSection() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <AutomationsSection />
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

const writes = () => calls.filter((call) => call.method !== 'GET');
const rowOf = (name: string) => screen.getByText(name, { selector: 'span' }).closest('li') as HTMLElement;
const truth = 'An automation only creates a task. It never edits records or sends anything.';

describe('the Automations section', () => {
  it('lists each rule with its sentence, toggle state, and fired count', async () => {
    renderSection();
    expect(screen.getByRole('heading', { name: 'Automations' })).toBeInTheDocument();
    await screen.findByText('Diligence prep');
    const prep = rowOf('Diligence prep');
    expect(within(prep).getByText('When a deal enters Diligence in Fundraising, create a task due in 2 days.')).toBeInTheDocument();
    expect(within(prep).getByText('Fired 3 times')).toBeInTheDocument();
    expect(within(prep).getByRole('checkbox', { name: 'Enabled: Diligence prep' })).toBeChecked();
    const welcome = rowOf('Welcome');
    expect(within(welcome).getByText('When a person becomes a relationship, create a task due the same day.')).toBeInTheDocument();
    expect(within(welcome).getByText('Fired 1 time')).toBeInTheDocument();
  });

  it('shows a rule whose pipeline was deleted as disabled with the reason', async () => {
    renderSection();
    await screen.findByText('Orphan');
    const orphan = rowOf('Orphan');
    expect(within(orphan).getByText(/The pipeline "Old pipeline" this rule named was deleted\./)).toBeInTheDocument();
    expect(within(orphan).getByText(/When a deal enters a stage that no longer exists, create a task due in 1 day\./)).toBeInTheDocument();
    const toggle = within(orphan).getByRole('checkbox', { name: 'Enabled: Orphan' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
  });

  it('wires the toggle to PATCH enabled with the row version', async () => {
    const { user } = renderSection();
    await screen.findByText('Diligence prep');
    await user.click(within(rowOf('Diligence prep')).getByRole('checkbox', { name: 'Enabled: Diligence prep' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'PATCH', path: '/api/automations/aut-1', body: { expectedVersion: 1, fields: { enabled: false } } });
    await waitFor(() => expect(within(rowOf('Diligence prep')).getByRole('checkbox')).not.toBeChecked());
  });

  it('creates a stage rule through cascading pipeline and stage selects', async () => {
    const { user } = renderSection();
    await screen.findByText('Diligence prep');
    await user.click(screen.getByRole('button', { name: 'New automation' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(truth)).toBeInTheDocument();
    expect(within(dialog).getByText('Write {name} to insert the deal\'s name.')).toBeInTheDocument();
    const create = within(dialog).getByRole('button', { name: 'Create automation' });
    expect(create).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Name'), 'Proposal prep');
    await user.type(within(dialog).getByLabelText('Task title'), 'Draft proposal for {{name}');
    const days = within(dialog).getByLabelText('Due in days');
    await user.clear(days);
    await user.type(days, '5');

    // The stage options follow the chosen pipeline.
    const stage = within(dialog).getByLabelText('Stage');
    expect(within(stage).getAllByRole('option').map((option) => option.textContent)).toEqual(['Research', 'Diligence']);
    await user.selectOptions(within(dialog).getByLabelText('Pipeline'), 'Sales');
    expect(within(stage).getAllByRole('option').map((option) => option.textContent)).toEqual(['Discovery', 'Proposal']);
    await user.selectOptions(stage, 'Proposal');

    await user.click(create);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: 'POST',
      path: '/api/automations',
      body: {
        name: 'Proposal prep',
        triggerKind: 'stage_entered',
        triggerConfig: { pipelineId: 'pip-sales', stageId: 'stg-sales-2' },
        actionConfig: { taskTitle: 'Draft proposal for {name}', dueInDays: 5 },
      },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('When a deal enters Proposal in Sales, create a task due in 5 days.')).toBeInTheDocument();
  });

  it('creates a person rule with no pipeline or stage selects', async () => {
    const { user } = renderSection();
    await screen.findByText('Diligence prep');
    await user.click(screen.getByRole('button', { name: 'New automation' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('When'), 'A person becomes a relationship');
    expect(within(dialog).queryByLabelText('Pipeline')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Stage')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Write {name} to insert the person\'s name.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'Intro');
    await user.type(within(dialog).getByLabelText('Task title'), 'Introduce yourself to {{name}');
    await user.click(within(dialog).getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toMatchObject({
      triggerKind: 'person_promoted',
      triggerConfig: {},
      actionConfig: { taskTitle: 'Introduce yourself to {name}', dueInDays: 0 },
    });
  });

  it('refuses a due value outside 0 to 365 before sending', async () => {
    const { user } = renderSection();
    await screen.findByText('Diligence prep');
    await user.click(screen.getByRole('button', { name: 'New automation' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Far');
    await user.type(within(dialog).getByLabelText('Task title'), 'Later');
    const days = within(dialog).getByLabelText('Due in days');
    await user.clear(days);
    await user.type(days, '366');
    expect(within(dialog).getByRole('button', { name: 'Create automation' })).toBeDisabled();
    expect(within(dialog).getByText(/Enter a whole number from 0 to 365/)).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it('edits a rule in the same sheet, prefilled, with the trigger kind locked', async () => {
    const { user } = renderSection();
    await screen.findByText('Diligence prep');
    await user.click(within(rowOf('Diligence prep')).getByRole('button', { name: 'Edit Diligence prep' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Edit automation' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Diligence prep');
    expect(within(dialog).getByLabelText('When')).toBeDisabled();
    expect(within(dialog).getByLabelText('Pipeline')).toHaveValue('pip-fund');
    expect(within(dialog).getByLabelText('Stage')).toHaveValue('stg-fund-2');
    expect(within(dialog).getByLabelText('Task title')).toHaveValue('Prepare for {name}');
    const days = within(dialog).getByLabelText('Due in days');
    await user.clear(days);
    await user.type(days, '7');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/automations/aut-1',
      body: { expectedVersion: 1, fields: { name: 'Diligence prep', actionConfig: { taskTitle: 'Prepare for {name}', dueInDays: 7 } } },
    });
    expect(writes()[0]!.body.fields.enabled).toBeUndefined();
  });

  it('turns a rule that a deletion switched off back on when it is saved with a new trigger', async () => {
    const { user } = renderSection();
    await screen.findByText('Orphan');
    await user.click(within(rowOf('Orphan')).getByRole('button', { name: 'Edit Orphan' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body.fields).toMatchObject({ triggerConfig: { pipelineId: 'pip-fund', stageId: 'stg-fund-1' }, enabled: true });
    await waitFor(() => expect(within(rowOf('Orphan')).getByRole('checkbox')).toBeChecked());
  });

  it('asks before deleting, says tasks stay, and deletes only on confirm', async () => {
    const { user } = renderSection();
    await screen.findByText('Welcome');
    await user.click(within(rowOf('Welcome')).getByRole('button', { name: 'Delete Welcome' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Delete Welcome? Tasks it already created stay.');
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Keep automation' }));
    expect(writes()).toHaveLength(0);
    await user.click(within(rowOf('Welcome')).getByRole('button', { name: 'Delete Welcome' }));
    await user.click(screen.getByRole('button', { name: 'Delete automation' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'DELETE', path: '/api/automations/aut-2' });
    await waitFor(() => expect(screen.queryByText('Welcome', { selector: 'span' })).not.toBeInTheDocument());
  });

  it('keeps the sheet open and says nothing was saved when the server refuses', async () => {
    const { user } = renderSection();
    await screen.findByText('Diligence prep');
    failure = { status: 400, code: 'validation', message: 'That stage does not exist.' };
    await user.click(screen.getByRole('button', { name: 'New automation' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Doomed');
    await user.type(within(dialog).getByLabelText('Task title'), 'T');
    await user.click(within(dialog).getByRole('button', { name: 'Create automation' }));
    expect(await within(dialog).findByText(/That stage does not exist\. The automation was not saved/)).toBeInTheDocument();
  });
});
