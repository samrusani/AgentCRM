// Adversarial probes for the Automations settings section. KILLS / CONFIRMS / ACCEPTED as in the server probes.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationsSection, automationSentence } from '../src/screens/AutomationSettings';
import { Router } from './helpers';

vi.mock('../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../src/api/events', () => ({ useServerEvents: () => {}, useEventConnection: () => 'open' }));

interface Call {
  method: string;
  path: string;
  body: any;
}
let calls: Call[];
let rules: any[];
let refuse: { status: number; message: string } | null;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const hostile = '<img src=x onerror=alert(1)>‮evil';
const pipelines = [
  { id: 'pip-a', name: `A ${hostile}`, template: 'client-sales', version: 1, stages: [
    { id: 'stg-a1', pipelineId: 'pip-a', name: 'A one', seq: 1 },
    { id: 'stg-a2', pipelineId: 'pip-a', name: `A two <b>bold</b>`, seq: 2 },
  ] },
  { id: 'pip-b', name: 'B', template: 'client-sales', version: 1, stages: [
    { id: 'stg-b2', pipelineId: 'pip-b', name: 'B two', seq: 2 },
    { id: 'stg-b1', pipelineId: 'pip-b', name: 'B one', seq: 1 },
  ] },
];
const rule = (o: Record<string, unknown>) => ({
  triggerKind: 'stage_entered', triggerConfig: { pipelineId: 'pip-a', stageId: 'stg-a2' }, actionConfig: { taskTitle: 'T {name}', dueInDays: 1 },
  enabled: true, disabledReason: null, firedCount: 0, version: 1, ...o,
});

beforeEach(() => {
  calls = [];
  refuse = null;
  rules = [
    rule({ id: 'r1', name: `Rule ${hostile}` }),
    rule({ id: 'r2', name: 'Off by hand', enabled: false }),
    rule({ id: 'r3', name: 'Orphan', triggerConfig: { pipelineId: 'pip-gone', stageId: 'stg-gone' }, enabled: false, disabledReason: `Gone ${hostile}` }),
    rule({ id: 'r4', name: 'Stage gone', triggerConfig: { pipelineId: 'pip-a', stageId: 'stg-gone' } }),
  ];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === '/api/pipelines') return json(200, { items: pipelines, nextCursor: null });
    if (url.pathname === '/api/automations' && method === 'GET') return json(200, { items: rules, nextCursor: null });
    if (method !== 'GET' && refuse) return json(refuse.status, { error: { code: 'validation', message: refuse.message } });
    const match = /^\/api\/automations\/([^/]+)$/.exec(url.pathname);
    if (match && method === 'PATCH') {
      const target = rules.find((r) => r.id === match[1]);
      Object.assign(target, body.fields, { version: target.version + 1 });
      return json(200, target);
    }
    if (match && method === 'DELETE') return new Response(null, { status: 204 });
    return json(404, { error: { code: 'not_found', message: 'x' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

function renderSection() {
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Router>
        <AutomationsSection />
      </Router>
    </QueryClientProvider>,
  );
  return { user, ...view };
}
const writes = () => calls.filter((c) => c.method !== 'GET');
const rowOf = (name: string) => screen.getByText(name, { selector: 'span' }).closest('li') as HTMLElement;

describe('rendering', () => {
  it('KILLS: hostile rule, pipeline, stage and reason text render as text, never as elements', async () => {
    const { container } = renderSection();
    await screen.findByText(`Rule ${hostile}`);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(within(rowOf(`Rule ${hostile}`)).getByText(`When a deal enters A two <b>bold</b> in A ${hostile}, create a task due in 1 day.`)).toBeInTheDocument();
    expect(within(rowOf('Orphan')).getByText(new RegExp('Gone <img'))).toBeInTheDocument();
  });

  it('KILLS: a missing pipeline or a missing stage both read as a stage that no longer exists; no pipelines loaded yet does too, never a blank or a throw', async () => {
    renderSection();
    await screen.findByText('Stage gone');
    expect(within(rowOf('Stage gone')).getByText(/a stage that no longer exists/)).toBeInTheDocument();
    expect(automationSentence(rules[0], undefined)).toMatch(/no longer exists/);
    expect(automationSentence(rule({ actionConfig: { taskTitle: 'x', dueInDays: 0 } }) as any, pipelines as any)).toMatch(/due the same day\.$/);
  });
});

describe('toggle', () => {
  it('KILLS: a deletion-disabled rule has a locked toggle; a hand-disabled rule does not, and a refused re-enable shows the server reason while the box stays off', async () => {
    const { user } = renderSection();
    await screen.findByText('Orphan');
    expect(within(rowOf('Orphan')).getByRole('checkbox')).toBeDisabled();
    expect(within(rowOf('Off by hand')).getByRole('checkbox')).not.toBeDisabled();
    refuse = { status: 400, message: 'The pipeline "X" was deleted. Edit the automation to pick a pipeline and stage that exist, then turn it on.' };
    await user.click(within(rowOf('Off by hand')).getByRole('checkbox'));
    expect(await within(rowOf('Off by hand')).findByRole('alert')).toHaveTextContent('The automation did not change.');
    expect(within(rowOf('Off by hand')).getByRole('checkbox')).not.toBeChecked();
  });
});

describe('sheet', () => {
  it('KILLS: the stage select follows the pipeline, resets to the new pipeline first stage by seq (not array order), and the payload carries the matching pair', async () => {
    const { user } = renderSection();
    await screen.findByText('Off by hand');
    await user.click(screen.getByRole('button', { name: 'New automation' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'N');
    await user.type(within(dialog).getByLabelText('Task title'), '{{name}');
    const stage = within(dialog).getByLabelText('Stage');
    await user.selectOptions(stage, 'stg-a2');
    await user.selectOptions(within(dialog).getByLabelText('Pipeline'), 'B');
    expect(within(stage).getAllByRole('option').map((o) => o.textContent)).toEqual(['B one', 'B two']); // sorted by seq
    expect(stage).toHaveValue('stg-b1'); // reset, not the stale stg-a2
    await user.click(within(dialog).getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toMatchObject({ triggerConfig: { pipelineId: 'pip-b', stageId: 'stg-b1' }, actionConfig: { taskTitle: '{name}', dueInDays: 0 } });
  });

  it('KILLS: due text edge cases; blank, -1, 1.5 and whitespace titles are blocked; 1e1 is a whole number and sends 10; padded input is trimmed', async () => {
    const { user } = renderSection();
    await screen.findByText('Off by hand');
    await user.click(screen.getByRole('button', { name: 'New automation' }));
    const dialog = await screen.findByRole('dialog');
    const create = within(dialog).getByRole('button', { name: 'Create automation' });
    await user.type(within(dialog).getByLabelText('Name'), '  Padded  ');
    await user.type(within(dialog).getByLabelText('Task title'), '   ');
    expect(create).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Task title'), 'Go');
    const days = within(dialog).getByLabelText('Due in days');
    for (const bad of ['', '-1', '1.5', '366']) {
      await user.clear(days);
      if (bad) await user.type(days, bad);
      expect(create, `days ${JSON.stringify(bad)}`).toBeDisabled();
    }
    await user.clear(days);
    await user.type(days, '1e1');
    expect(create).toBeEnabled();
    await user.click(create);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toMatchObject({ name: 'Padded', actionConfig: { taskTitle: 'Go', dueInDays: 10 } });
  });

  it('KILLS: editing a rule disabled by a deletion shows a plain line saying the old target is gone and a new stage must be chosen; retargeting and saving is the safe flow', async () => {
    const { user } = renderSection();
    await screen.findByText('Orphan');
    await user.click(within(rowOf('Orphan')).getByRole('button', { name: 'Edit Orphan' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The stage this rule pointed at was deleted. Choose a new pipeline and stage before saving.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Pipeline')).toHaveValue('pip-a');
    expect(within(dialog).getByLabelText('Stage')).toHaveValue('stg-a1');
    await user.type(within(dialog).getByLabelText('Name'), ' renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body.fields).toMatchObject({ name: 'Orphan renamed', triggerConfig: { pipelineId: 'pip-a', stageId: 'stg-a1' }, enabled: true });
  });

  it('KILLS: a version conflict says nothing was saved and keeps the sheet; the sheet sends the version from when it opened', async () => {
    const { user } = renderSection();
    await screen.findByText('Off by hand');
    await user.click(within(rowOf('Off by hand')).getByRole('button', { name: 'Edit Off by hand' }));
    const dialog = await screen.findByRole('dialog');
    rules[1].version = 5;
    refuse = { status: 409, message: 'stale' };
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body.expectedVersion).toBe(1);
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('delete', () => {
  it('KILLS: the confirm names the rule as text, says tasks stay, and a refused delete says it was not deleted and keeps the row', async () => {
    const { user, container } = renderSection();
    await screen.findByText(`Rule ${hostile}`);
    await user.click(within(rowOf(`Rule ${hostile}`)).getByRole('button', { name: `Delete Rule ${hostile}` }));
    expect(screen.getByRole('alert')).toHaveTextContent(`Delete Rule ${hostile}? Tasks it already created stay.`);
    expect(container.querySelector('img')).toBeNull();
    refuse = { status: 404, message: 'Automation not found.' };
    await user.click(screen.getByRole('button', { name: 'Delete automation' }));
    expect(await screen.findByText(/The automation was not deleted\./)).toBeInTheDocument();
    expect(screen.getByText(`Rule ${hostile}`, { selector: 'span' })).toBeInTheDocument();
  });
});
