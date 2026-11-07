import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RecordPicker, type PickedRecord, type PickerKind } from '../src/components/RecordPicker';
import { PersonSheet } from '../src/screens/RecordSheets';
import { useOrganizations } from '../src/api/hooks';
import { ApiError } from '../src/api/client';
import { Router } from './helpers';

// Review probes for the editable Organization row and the picker create option.
// Convention: KILLS asserts the safe behavior holds. CONFIRMS pins a live bug as it behaves today and says in a
// comment what should happen instead. ACCEPTED pins a documented limit.

vi.mock('../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../src/api/events', () => ({
  useServerEvents: () => {},
  useEventConnection: () => 'open',
}));

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
}

type Org = { id: string; version: number; name: string; domain: string | null; kind: string; location: null; tags: string[] };

let calls: Call[];
let personOrg: Org | null;
let personVersion: number;
let patchFailure: { status: number; code: string; message: string; current?: unknown } | null;
let postFailure: { status: number; code: string; message: string } | null;
// Gates a request until the test releases it. Search is gated per query text.
let searchGates: Record<string, Promise<void>>;
let postGate: Promise<void> | null;
let patchGate: Promise<void> | null;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const org = (id: string, name: string, domain: string | null = null): Org => ({ id, version: 1, name, domain, kind: 'company', location: null, tags: [] });
const ACME = org('org-1', 'Acme Capital', 'acme.example.com');
const BETA = org('org-2', 'Beta Labs');
const BETA_TWO = org('org-3', 'Beta Partners');
const KNOWN = [ACME, BETA, BETA_TWO];

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
    organizationId: personOrg?.id ?? null,
    organizationName: personOrg?.name ?? null,
    organization: personOrg,
    location: null,
    tags: [],
    nextActionAt: null,
    createdAt: '2026-10-01T10:00:00',
    updatedAt: '2026-11-01T10:00:00',
    claims: [],
    activities: [],
    tasks: [],
    opportunities: [],
  };
}

beforeEach(() => {
  calls = [];
  personOrg = ACME;
  personVersion = 3;
  patchFailure = null;
  postFailure = null;
  searchGates = {};
  postGate = null;
  patchGate = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, search: url.searchParams, body });
      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const held = searchGates[q];
        if (held) await held;
        return json(200, { people: [], organizations: KNOWN.filter((o) => o.name.toLowerCase().includes(q)), opportunities: [] });
      }
      if (url.pathname === '/api/organizations' && method === 'POST') {
        if (postGate) await postGate;
        if (postFailure) return json(postFailure.status, { error: { code: postFailure.code, message: postFailure.message } });
        const created = org(`org-new-${KNOWN.length}`, body.name);
        KNOWN.push(created);
        return json(201, created);
      }
      if (url.pathname === '/api/organizations' && method === 'GET') return json(200, { items: KNOWN, nextCursor: null });
      if (url.pathname === '/api/pipelines') return json(200, { items: [{ id: 'pipe-1', name: 'Fundraising', stages: [{ id: 'stage-1', pipelineId: 'pipe-1', name: 'Prospect', seq: 1 }] }], nextCursor: null });
      if (url.pathname === '/api/people/person-1' && method === 'PATCH') {
        if (patchGate) await patchGate;
        if (patchFailure) {
          const { status, code, message, current } = patchFailure;
          return json(status, { error: { code, message, current } });
        }
        if (body.expectedVersion !== personVersion) {
          return json(409, { error: { code: 'version_conflict', message: 'This record changed since you loaded it.', current: { version: personVersion } } });
        }
        const next = body.fields.organizationId as string | null;
        personOrg = next ? (KNOWN.find((o) => o.id === next) ?? null) : null;
        personVersion += 1;
        return json(200, personBody());
      }
      if (url.pathname === '/api/people/person-1') return json(200, personBody());
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      if (url.pathname === '/api/activities') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  KNOWN.splice(3);
});

const posts = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/organizations');
const personPatches = () => calls.filter((c) => c.method === 'PATCH' && c.path === '/api/people/person-1');
const searchesFor = (q: string) => calls.filter((c) => c.path === '/api/search' && c.search.get('q')?.toLowerCase() === q.toLowerCase());
const createName = (text: string) => `Add "${text}" as a new organization`;
const createOption = (text: string) => screen.queryByRole('option', { name: createName(text) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// ---------------------------------------------------------------------------------------------------------------
// Picker level probes

function renderPicker(props: { kind?: PickerKind; onCreate?: (name: string) => Promise<PickedRecord>; inForm?: () => void } = {}) {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const client = newClient();
  const picker = (
    <RecordPicker kind={props.kind ?? 'organization'} label="Organization" value={null} onChange={onChange} onCreate={props.onCreate} />
  );
  render(
    <QueryClientProvider client={client}>
      {props.inForm ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.inForm!();
          }}
        >
          {picker}
          <button type="submit">Save</button>
        </form>
      ) : (
        picker
      )}
    </QueryClientProvider>,
  );
  return { user, onChange, client, input: screen.getByRole('combobox', { name: 'Organization' }) };
}

// A create that stays pending until released, and then resolves to a new record.
function pendingCreate() {
  const held = gate();
  const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => {
    await held.promise;
    return { id: 'org-made', name };
  });
  return { onCreate, release: held.release };
}

describe('review probes: double submission', () => {
  it('KILLS: Enter twice in a row on the create option calls onCreate once', async () => {
    const { onCreate, release } = pendingCreate();
    const { user, onChange, input } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    await screen.findByRole('option', { name: createName('Newco') });
    await user.keyboard('{Enter}{Enter}{Enter}');
    release();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('KILLS: Enter then a click on the create option calls onCreate once', async () => {
    const { onCreate, release } = pendingCreate();
    const { user, onChange, input } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    const option = await screen.findByRole('option', { name: createName('Newco') });
    await user.keyboard('{Enter}');
    await user.click(option);
    release();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('KILLS: two clicks on the create option call onCreate once', async () => {
    const { onCreate, release } = pendingCreate();
    const { user, onChange, input } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    const option = await screen.findByRole('option', { name: createName('Newco') });
    await user.dblClick(option);
    release();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('KILLS: tabbing away while the create is pending keeps the popover and does not start a second create', async () => {
    const { onCreate, release } = pendingCreate();
    const { user, onChange, input } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    await screen.findByRole('option', { name: createName('Newco') });
    await user.keyboard('{Enter}');
    expect(input).toBeDisabled();
    await user.tab();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByText('Adding organization...')).toBeInTheDocument();
    release();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: 'org-made', name: 'Newco' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('KILLS: while a create is pending, clicking an existing match does not choose it', async () => {
    const { onCreate, release } = pendingCreate();
    const { user, onChange, input } = renderPicker({ onCreate });
    await user.type(input, 'Beta');
    await screen.findByRole('option', { name: createName('Beta') });
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    // Both Beta matches and the create option are still on screen, marked disabled.
    const existing = screen.getByRole('option', { name: /Beta Labs/ });
    expect(existing).toHaveAttribute('aria-disabled', 'true');
    await user.click(existing);
    expect(onChange).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith({ id: 'org-made', name: 'Beta' });
  });

  // Two key events inside ONE act() scope used to both pass the state based guard. The create is now also guarded by
  // a ref, so exactly one create fires however the events are batched.
  it('KILLS: two keydown events batched inside a single act() scope reach onCreate once', async () => {
    const { onCreate, release } = pendingCreate();
    const { user, input } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    await screen.findByRole('option', { name: createName('Newco') });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    release();
    await sleep(20);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});

describe('review probes: stale list races', () => {
  it('KILLS: Enter inside the debounce window after the list settled creates nothing', async () => {
    const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => ({ id: 'org-made', name }));
    const { user, onChange, input } = renderPicker({ onCreate });
    await user.type(input, 'acme');
    await screen.findByRole('option', { name: createName('acme') });
    await user.type(input, 'x{Enter}');
    expect(onCreate).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    // The option that eventually appears names the text that is in the field now, never the old text.
    expect(await screen.findByRole('option', { name: createName('acmex') })).toBeInTheDocument();
    expect(createOption('acme')).not.toBeInTheDocument();
  });

  it('KILLS: the create option and the name it sends always come from the same trimmed text', async () => {
    const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => ({ id: 'org-made', name }));
    const { user, onChange, input } = renderPicker({ onCreate });
    await user.type(input, '   Spaced Out Co   ');
    const option = await screen.findByRole('option', { name: createName('Spaced Out Co') });
    await user.click(option);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalledWith('Spaced Out Co');
  });

  it('KILLS: the create option is absent while the search for the typed text is still in flight', async () => {
    const held = gate();
    searchGates['zeta'] = held.promise;
    const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => ({ id: 'org-made', name }));
    const { user, input } = renderPicker({ onCreate });
    await user.type(input, 'zeta');
    await waitFor(() => expect(searchesFor('zeta')).toHaveLength(1));
    expect(createOption('zeta')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onCreate).not.toHaveBeenCalled();
    held.release();
    expect(await screen.findByRole('option', { name: createName('zeta') })).toBeInTheDocument();
  });

  // The debounce has caught up but the search for the new text is still in flight. useSearch keeps the previous
  // results as placeholder data, so the list still shows the OLD query's matches. Enter is gated on `settled` (list
  // current and no fetch in flight), so it takes nothing from that stale list.
  it('KILLS: Enter after the debounce lands but before the new search answers chooses nothing', async () => {
    const held = gate();
    searchGates['acmez'] = held.promise;
    const { user, onChange, input } = renderPicker({ onCreate: vi.fn() });
    await user.type(input, 'acme');
    await screen.findByRole('option', { name: /Acme Capital/ });
    await user.type(input, 'z');
    await waitFor(() => expect(searchesFor('acmez')).toHaveLength(1));
    // The list on screen is still the old one and the field says "acmez".
    expect(input).toHaveValue('acmez');
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    held.release();
    await waitFor(() => expect(createOption('acmez')).toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('review probes: option index', () => {
  it('KILLS: ArrowDown reaches the create option and Enter creates, it does not pick the last match', async () => {
    const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => ({ id: 'org-made', name }));
    const { user, onChange, input } = renderPicker({ onCreate });
    await user.type(input, 'Beta');
    await screen.findByRole('option', { name: createName('Beta') });
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('option', { name: createName('Beta') })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalledWith('Beta');
    expect(onChange.mock.calls[0][0].id).toBe('org-made');
  });

  it('KILLS: Enter on the first match picks the existing record and never calls onCreate', async () => {
    const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => ({ id: 'org-made', name }));
    const { user, onChange, input } = renderPicker({ onCreate });
    await user.type(input, 'Beta');
    await screen.findByRole('option', { name: createName('Beta') });
    await user.keyboard('{Enter}');
    expect(onChange.mock.calls[0][0].id).toBe('org-2');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('KILLS: ArrowUp from the first option wraps to the create option', async () => {
    const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => ({ id: 'org-made', name }));
    const { user, input } = renderPicker({ onCreate });
    await user.type(input, 'Beta');
    await screen.findByRole('option', { name: createName('Beta') });
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { name: createName('Beta') })).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: createName('Beta') }).id);
  });

  // The user has the create option highlighted. A background refetch of the same search (window refocus, a server
  // event, another mutation invalidating ['search']) hides the create option while the matches stay, and the highlight
  // index would clamp onto the last existing match. Enter is gated on `settled`, so during the refetch it does
  // nothing, and once the refetch lands the create option is back and still highlighted.
  it('KILLS: a background refetch hides the highlighted create option and Enter then does nothing', async () => {
    const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => ({ id: 'org-made', name }));
    const { user, onChange, client, input } = renderPicker({ onCreate });
    await user.type(input, 'Beta');
    await screen.findByRole('option', { name: createName('Beta') });
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('option', { name: createName('Beta') })).toHaveAttribute('aria-selected', 'true');
    const held = gate();
    searchGates['beta'] = held.promise;
    void act(() => {
      void client.invalidateQueries({ queryKey: ['search'] });
    });
    await waitFor(() => expect(createOption('Beta')).not.toBeInTheDocument());
    await user.keyboard('{Enter}');
    expect(onCreate).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    held.release();
    expect(await screen.findByRole('option', { name: createName('Beta') })).toHaveAttribute('aria-selected', 'true');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('KILLS: a background refetch that changes the match count resets the highlight to the first option', async () => {
    const { user, client, input } = renderPicker({ onCreate: vi.fn() });
    await user.type(input, 'Beta');
    await screen.findByRole('option', { name: createName('Beta') });
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /Beta Partners/ })).toHaveAttribute('aria-selected', 'true');
    KNOWN.push(org('org-9', 'Beta Extra'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['search'] });
    });
    await waitFor(() => expect(screen.getByRole('option', { name: /Beta Extra/ })).toBeInTheDocument());
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });
});

describe('review probes: names', () => {
  it('KILLS: a whitespace only field shows no popover, sends no search, and offers no create option', async () => {
    const onCreate = vi.fn();
    const { user, input } = renderPicker({ onCreate });
    await user.type(input, '    ');
    await sleep(300);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/api/search')).toHaveLength(0);
    await user.keyboard('{Enter}');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('KILLS: non breaking and ideographic spaces count as blank, like the server trim', async () => {
    const onCreate = vi.fn();
    const { input } = renderPicker({ onCreate });
    fireEvent.change(input, { target: { value: ' 　 ' } });
    await sleep(300);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/api/search')).toHaveLength(0);
  });

  // A zero width space is not whitespace to String.trim. The picker strips invisible format characters (the class
  // tidyLink uses) before the empty check, so a field holding only those sends no search, shows no popover, and
  // offers no create option. Invisible characters around or inside a real name are dropped from the sent name.
  it('KILLS: a zero width space alone counts as empty and is never searched, offered, or created', async () => {
    const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => ({ id: 'org-made', name }));
    const { user, onChange, input } = renderPicker({ onCreate });
    fireEvent.change(input, { target: { value: '\u200B\u00AD\uFEFF \u2060' } });
    await sleep(300);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/api/search')).toHaveLength(0);
    await user.keyboard('{Enter}');
    expect(onCreate).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('KILLS: invisible characters inside a real name are dropped from the option label and the sent name', async () => {
    const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => ({ id: 'org-made', name }));
    const { user, onChange, input } = renderPicker({ onCreate });
    fireEvent.change(input, { target: { value: '\u200BNew\u200Bco\u202E ' } });
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalledWith('Newco');
  });

  // ACCEPTED: the client has no length cap. A 201 character name posts as typed and the server (name max 200 in
  // apps/server/src/actions/entities.ts) rejects it. The failure note is the next probe at the sheet level.
  it('ACCEPTED: a 201 character name still offers the create option and sends all 201 characters', async () => {
    const long = 'N'.repeat(201);
    const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => ({ id: 'org-made', name }));
    const { user, onChange, input } = renderPicker({ onCreate });
    fireEvent.change(input, { target: { value: long } });
    await user.click(await screen.findByRole('option', { name: createName(long) }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).toHaveLength(201);
  });

  it('KILLS: a failed create keeps the text, shows the note with a next step, refocuses the input, and a retry works', async () => {
    const onCreate = vi
      .fn<(name: string) => Promise<PickedRecord>>()
      .mockRejectedValueOnce(new ApiError(400, 'validation', 'name: String must contain at most 200 character(s).'))
      .mockImplementation(async (name) => ({ id: 'org-made', name }));
    const { user, onChange, input } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    const note = await screen.findByRole('alert');
    expect(note).toHaveTextContent('name: String must contain at most 200 character(s). Fix the name and try again.');
    expect(input).toHaveValue('Newco');
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByRole('option', { name: createName('Newco') })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: 'org-made', name: 'Newco' }));
    expect(onCreate).toHaveBeenCalledTimes(2);
  });

  it('KILLS: typing after a failure clears the failure note', async () => {
    const onCreate = vi.fn().mockRejectedValue(new ApiError(500, 'internal', 'Something went wrong on the server.'));
    const { user, input } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    await screen.findByRole('alert');
    await user.type(input, 's');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // The ZodError branch in apps/server/src/http/app.ts sends issue.message as is, so the message can lack a final
  // period. The picker adds one so the note reads as full sentences, and a 400 ends "Fix the name and try again."
  it('KILLS: a server message without a final period gets one before the next step sentence', async () => {
    const onCreate = vi.fn().mockRejectedValue(new ApiError(400, 'validation', 'String must contain at most 200 character(s)'));
    const { user, input } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    expect(await screen.findByRole('alert')).toHaveTextContent('String must contain at most 200 character(s). Fix the name and try again.');
  });

  // The closing sentence follows the error class: a 400 validation refusal says to fix the name, anything else
  // (network failure, 5xx) just says to try again.
  it('KILLS: an unreachable server or a 5xx only says to try again, never to fix the name', async () => {
    const onCreate = vi.fn().mockRejectedValue(
      new ApiError(0, 'network', 'Cannot reach the AgentCRM server. Start it with npm run dev from the repository root, then retry.'),
    );
    const { user, input } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    const note = (await screen.findByRole('alert')).textContent ?? '';
    expect(note).toMatch(/then retry\. Try again\.$/);
    expect(note).not.toMatch(/Fix the name/);
  });

  it('KILLS: a 500 without a final period reads as a sentence and ends with Try again', async () => {
    const onCreate = vi.fn().mockRejectedValue(new ApiError(500, 'internal', 'Something went wrong on the server'));
    const { user, input } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong on the server. Try again.');
  });
});

describe('review probes: people kind and old guarantees', () => {
  it('KILLS: a person picker ignores onCreate for Enter, ArrowDown and clicks', async () => {
    const onCreate = vi.fn();
    const { user, onChange, input } = renderPicker({ kind: 'person', onCreate });
    await user.type(input, 'Newco');
    expect(await screen.findByText('No people match this search.')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('KILLS: Enter on the create option never submits the surrounding form', async () => {
    const submitted = vi.fn();
    const onCreate = vi.fn(async (name: string): Promise<PickedRecord> => ({ id: 'org-made', name }));
    const { user, onChange, input } = renderPicker({ onCreate, inForm: submitted });
    await user.type(input, 'Newco');
    await screen.findByRole('option', { name: createName('Newco') });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(submitted).not.toHaveBeenCalled();
  });

  it('KILLS: Enter with no popover and no matches never submits the form either', async () => {
    const submitted = vi.fn();
    const { user, input } = renderPicker({ onCreate: vi.fn(), inForm: submitted });
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(submitted).not.toHaveBeenCalled();
  });

  // Picker level only: the picker alone leaves the second Escape unhandled. On the person sheet's Organization row the
  // second Escape now cancels the edit and only a third closes the sheet (see the sheet level probe below).
  it('KILLS: Escape closes the popover and is marked handled, a second Escape is left for the sheet', async () => {
    const seen: boolean[] = [];
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') seen.push(event.defaultPrevented);
    };
    document.addEventListener('keydown', listener);
    try {
      const { user, input } = renderPicker({ onCreate: vi.fn() });
      await user.type(input, 'Beta');
      await screen.findByRole('option', { name: createName('Beta') });
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(seen).toEqual([true, false]);
    } finally {
      document.removeEventListener('keydown', listener);
    }
  });

  it('KILLS: the input keeps an accessible name without a visible label when hideLabel is on', () => {
    render(
      <QueryClientProvider client={newClient()}>
        <RecordPicker kind="organization" label="Organization" hideLabel value={null} onChange={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('combobox', { name: 'Organization' })).toBeInTheDocument();
    expect(document.querySelector('label')).toBeNull();
    // The chosen state keeps its name too.
  });

  it('KILLS: the chosen state with hideLabel is a named group with a clear control', () => {
    render(
      <QueryClientProvider client={newClient()}>
        <RecordPicker kind="organization" label="Organization" hideLabel value={{ id: 'o', name: 'Acme' }} onChange={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('group', { name: 'Organization' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear organization' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Person sheet probes

function OrganizationsList() {
  const list = useOrganizations('');
  const names = (list.data?.pages ?? []).flatMap((page) => page.items.map((item) => item.name));
  return <output data-testid="org-list">{names.join('|')}</output>;
}

// A host that can unmount the sheet the way the app does when onClose runs.
function Host({ onOpenOrganization, withList }: { onOpenOrganization: (id: string) => void; withList?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {withList ? <OrganizationsList /> : null}
      <output data-testid="host-state">{open ? 'open' : 'closed'}</output>
      {open ? <PersonSheet id="person-1" onClose={() => setOpen(false)} onOpenOrganization={onOpenOrganization} /> : null}
    </>
  );
}

function renderSheet(withList = false) {
  const user = userEvent.setup();
  const client = newClient();
  const onOpenOrganization = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <Router>
        <Host onOpenOrganization={onOpenOrganization} withList={withList} />
      </Router>
    </QueryClientProvider>,
  );
  return { user, client, onOpenOrganization };
}

const orgInput = () => screen.getByRole('combobox', { name: 'Organization' });
const orgRow = () => screen.getByText('Organization', { selector: 'dt' }).closest('.field') as HTMLElement;
const hostState = () => screen.getByTestId('host-state').textContent;

async function startEditing(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Edit organization' }));
  return orgInput();
}

describe('review probes: escape and click-away against in-flight work', () => {
  // While the create is pending the input is disabled and loses focus, so Escape lands on the body. A document level
  // capture listener registered during edit mode swallows it: the sheet stays open, nothing is cancelled, and the
  // create and link still finish, with the row ending on the new organization.
  it('KILLS: Escape during a pending create keeps the sheet open, and the row ends on the created organization', async () => {
    const held = gate();
    postGate = held.promise;
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await user.keyboard('{Escape}');
    expect(hostState()).toBe('open');
    expect(screen.getByRole('combobox', { name: 'Organization' })).toBeDisabled();
    held.release();
    await waitFor(() => expect(personPatches()).toHaveLength(1));
    expect(personPatches()[0].body.fields.organizationId).toMatch(/^org-new-/);
    expect(await screen.findByRole('button', { name: /^Newco$/ })).toBeInTheDocument();
    expect(hostState()).toBe('open');
  });

  // Same hole once the pick is saving: the picker is replaced by "Saving...", focus falls to the body. The capture
  // listener swallows Escape, the sheet stays open, the save completes, and the row shows the stored organization.
  it('KILLS: Escape while the link PATCH is in flight keeps the sheet open, and the row ends on the stored link', async () => {
    const { user } = renderSheet();
    await startEditing(user);
    const held = gate();
    patchGate = held.promise;
    await user.type(orgInput(), 'Beta');
    await user.click(await screen.findByRole('option', { name: /Beta Labs/ }));
    await screen.findByText('Saving...');
    await user.keyboard('{Escape}');
    expect(hostState()).toBe('open');
    expect(screen.getByText('Saving...')).toBeInTheDocument();
    held.release();
    await waitFor(() => expect(personOrg?.id).toBe('org-2'));
    expect(await screen.findByRole('button', { name: 'Beta Labs' })).toBeInTheDocument();
    expect(hostState()).toBe('open');
  });

  // Sheet level contract: with the list open the first Escape closes the list, the second cancels the edit, and only
  // the third (view mode) closes the sheet.
  it('KILLS: on the sheet the first Escape closes the list, the second cancels the edit, the third closes the sheet', async () => {
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Beta');
    await screen.findByRole('option', { name: /Beta Labs/ });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(orgInput()).toBeInTheDocument();
    expect(hostState()).toBe('open');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox', { name: 'Organization' })).not.toBeInTheDocument();
    expect(hostState()).toBe('open');
    await user.keyboard('{Escape}');
    expect(hostState()).toBe('closed');
  });

  it('KILLS: clicking away while the link PATCH is in flight does not cancel, and the row ends on the stored value', async () => {
    const { user } = renderSheet();
    await startEditing(user);
    const held = gate();
    patchGate = held.promise;
    await user.type(orgInput(), 'Beta');
    await user.click(await screen.findByRole('option', { name: /Beta Labs/ }));
    await screen.findByText('Saving...');
    await user.click(screen.getByText('Fields'));
    expect(screen.getByText('Saving...')).toBeInTheDocument();
    held.release();
    expect(await screen.findByRole('button', { name: 'Beta Labs' })).toBeInTheDocument();
    expect(within(orgRow()).queryByText('Saving...')).not.toBeInTheDocument();
    expect(personOrg?.id).toBe('org-2');
  });

  it('KILLS: clicking away while a create is pending does not cancel the row', async () => {
    const held = gate();
    postGate = held.promise;
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await user.click(screen.getByText('Fields'));
    expect(screen.getByRole('combobox', { name: 'Organization' })).toBeDisabled();
    held.release();
    expect(await screen.findByRole('button', { name: /^Newco$/ })).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(personPatches()).toHaveLength(1);
  });

  it('KILLS: Remove organization is hidden while a create is pending, so it cannot race the create', async () => {
    const held = gate();
    postGate = held.promise;
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Remove organization' })).not.toBeInTheDocument();
    held.release();
    await screen.findByRole('button', { name: /^Newco$/ });
  });

  it('KILLS: Escape from the Remove organization button leaves edit mode and keeps the sheet open', async () => {
    const { user } = renderSheet();
    await startEditing(user);
    screen.getByRole('button', { name: 'Remove organization' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox', { name: 'Organization' })).not.toBeInTheDocument();
    expect(hostState()).toBe('open');
    expect(personPatches()).toHaveLength(0);
  });

  // Clicking a non focusable spot inside the row (for example the error text) moves focus to the body. The row is
  // still in edit mode and the document level listener still cancels it, so the sheet stays open.
  it('KILLS: after clicking the error text inside the row, Escape cancels the edit and keeps the sheet open', async () => {
    patchFailure = { status: 500, code: 'internal', message: 'Something went wrong on the server.' };
    const { user } = renderSheet();
    await startEditing(user);
    await user.click(screen.getByRole('button', { name: 'Remove organization' }));
    const note = await screen.findByRole('alert');
    await user.click(note);
    expect(document.body).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(hostState()).toBe('open');
    expect(screen.queryByRole('combobox', { name: 'Organization' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit organization' })).toBeInTheDocument();
  });
});

describe('review probes: version conflicts', () => {
  it('KILLS: a 409 shows the conflict block, Reload record leaves edit mode, and the next save carries the new version', async () => {
    patchFailure = { status: 409, code: 'version_conflict', message: 'This record changed since you loaded it.', current: { version: 4, organizationName: 'Beta Partners' } };
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Beta');
    await user.click(await screen.findByRole('option', { name: /Beta Labs/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('It is now "Beta Partners".');
    expect(within(alert).getByRole('button', { name: 'Reload record' })).toBeInTheDocument();
    // The server really moved on.
    patchFailure = null;
    personOrg = BETA_TWO;
    personVersion = 4;
    await user.click(within(alert).getByRole('button', { name: 'Reload record' }));
    expect(await screen.findByRole('button', { name: 'Beta Partners' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Organization' })).not.toBeInTheDocument();
    // A second edit now sends version 4, not 3.
    await user.click(screen.getByRole('button', { name: 'Edit organization' }));
    await user.type(orgInput(), 'Acme');
    await user.click(await screen.findByRole('option', { name: /Acme Capital/ }));
    expect(await screen.findByRole('button', { name: 'Acme Capital' })).toBeInTheDocument();
    expect(personPatches().map((c) => c.body.expectedVersion)).toEqual([3, 4]);
  });

  // A 409 now refetches the person in place, like the lifecycle control does, so a second pick without pressing
  // Reload carries the current version. The server moves on to version 4 here, and the second pick sends 4.
  it('KILLS: picking again after a conflict without Reload sends the refetched version', async () => {
    patchFailure = { status: 409, code: 'version_conflict', message: 'This record changed since you loaded it.', current: { version: 4 } };
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Beta');
    personVersion = 4;
    personOrg = BETA_TWO;
    await user.click(await screen.findByRole('option', { name: /Beta Labs/ }));
    await screen.findByRole('alert');
    patchFailure = null;
    await user.type(orgInput(), 'Acme');
    await user.click(await screen.findByRole('option', { name: /Acme Capital/ }));
    await waitFor(() => expect(personPatches()).toHaveLength(2));
    expect(personPatches().map((c) => c.body.expectedVersion)).toEqual([3, 4]);
    expect(await screen.findByRole('button', { name: 'Acme Capital' })).toBeInTheDocument();
  });

  it('KILLS: the conflict message falls back to neutral wording when the server sends no organization name', async () => {
    patchFailure = { status: 409, code: 'version_conflict', message: 'x', current: { version: 4 } };
    const { user } = renderSheet();
    await startEditing(user);
    await user.click(screen.getByRole('button', { name: 'Remove organization' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The current value is different from the one you saw. Your change was not saved.');
  });

  it('KILLS: a real version mismatch from the server (not a canned failure) surfaces the conflict block', async () => {
    const { user } = renderSheet();
    await screen.findByRole('button', { name: 'Edit organization' });
    // Someone else bumps the record after this sheet loaded it.
    personVersion = 9;
    await user.click(screen.getByRole('button', { name: 'Edit organization' }));
    await user.click(screen.getByRole('button', { name: 'Remove organization' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: 'Reload record' })).toBeInTheDocument();
    expect(personPatches()[0].body.expectedVersion).toBe(3);
  });
});

describe('review probes: save path after a create', () => {
  // The organization was created, then the link PATCH fails. The picker remounts empty, so the failure line names the
  // created record and tells the user to search for it and pick it, instead of the generic "not changed" wording.
  it('KILLS: a failed link after a create says the organization was added but not linked', async () => {
    patchFailure = { status: 500, code: 'internal', message: 'Something went wrong on the server.' };
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    const note = await screen.findByRole('alert');
    expect(note).toHaveTextContent('"Newco" was added but not linked. Search for it and pick it to finish linking.');
    expect(note.textContent).not.toMatch(/not been changed|was not changed/i);
    expect(posts()).toHaveLength(1);
    // The field is empty again.
    expect(orgInput()).toHaveValue('');
  });

  it('KILLS: after a failed link the user can link the already created organization without a second POST', async () => {
    patchFailure = { status: 500, code: 'internal', message: 'Something went wrong on the server.' };
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    await screen.findByRole('alert');
    patchFailure = null;
    await user.type(orgInput(), 'Newco');
    // The created record is searchable now, so it shows as a normal match.
    const match = await screen.findByRole('option', { name: /^Newco$/ });
    await user.click(match);
    expect(await screen.findByRole('button', { name: 'Newco' })).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(personPatches()).toHaveLength(2);
  });

  // Names are not unique by design (docs/design.md: "an existing match never hides it, since names are not unique"),
  // so the create option stays beside the existing Newco match. The failure line now says Newco was added and tells
  // the user to search for it and pick it, which steers them to the existing match instead of a second create.
  it('ACCEPTED: a user who retypes the same name after the failed link is still offered a create, by design', async () => {
    patchFailure = { status: 500, code: 'internal', message: 'Something went wrong on the server.' };
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    await screen.findByRole('alert');
    await user.type(orgInput(), 'Newco');
    await screen.findByRole('option', { name: /^Newco$/ });
    expect(createOption('Newco')).toBeInTheDocument();
  });

  it('KILLS: a create that fails with a 400 shows the server wording plus a next step and leaves the person untouched', async () => {
    postFailure = { status: 400, code: 'validation', message: 'name: String must contain at most 200 character(s).' };
    const { user } = renderSheet();
    await startEditing(user);
    const long = 'N'.repeat(201);
    fireEvent.change(orgInput(), { target: { value: long } });
    await user.click(await screen.findByRole('option', { name: createName(long) }));
    const note = await screen.findByRole('alert');
    expect(note).toHaveTextContent('name: String must contain at most 200 character(s). Fix the name and try again.');
    expect(posts()[0].body.name).toHaveLength(201);
    expect(personPatches()).toHaveLength(0);
    expect(orgInput()).toHaveValue(long);
    expect(screen.getByRole('button', { name: 'Remove organization' })).toBeInTheDocument();
  });

  it('KILLS: the same name typed twice with padding sends the trimmed name once per intent', async () => {
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), '  Padded Co  ');
    await user.click(await screen.findByRole('option', { name: createName('Padded Co') }));
    await screen.findByRole('button', { name: 'Padded Co' });
    expect(posts().map((c) => c.body)).toEqual([{ name: 'Padded Co' }]);
  });
});

describe('review probes: what follows a relink', () => {
  it('KILLS: the subtitle and the New opportunity prefill follow the new organization', async () => {
    const { user } = renderSheet();
    await startEditing(user);
    expect(await screen.findByText('Partner at Acme Capital')).toBeInTheDocument();
    await user.type(orgInput(), 'Beta');
    await user.click(await screen.findByRole('option', { name: /Beta Labs/ }));
    await screen.findByRole('button', { name: 'Beta Labs' });
    expect(await screen.findByText('Partner at Beta Labs')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New opportunity' }));
    const group = await screen.findByRole('group', { name: 'Organization' });
    expect(within(group).getByText('Beta Labs')).toBeInTheDocument();
  });

  it('KILLS: removing the organization clears the subtitle and the New opportunity prefill', async () => {
    const { user } = renderSheet();
    await startEditing(user);
    await user.click(screen.getByRole('button', { name: 'Remove organization' }));
    await waitFor(() => expect(within(orgRow()).getByText('None')).toBeInTheDocument());
    expect(document.querySelector('.sheet__subtitle')?.textContent).toBe('Partner');
    await user.click(screen.getByRole('button', { name: 'New opportunity' }));
    await screen.findByLabelText('Name');
    expect(screen.queryByRole('group', { name: 'Organization' })).not.toBeInTheDocument();
  });

  it('KILLS: a create plus a link refetches the organizations list without a manual reload', async () => {
    KNOWN.length = 0;
    KNOWN.push(ACME, BETA, BETA_TWO);
    const { user } = renderSheet(true);
    await waitFor(() => expect(screen.getByTestId('org-list')).toHaveTextContent('Acme Capital|Beta Labs|Beta Partners'));
    await startEditing(user);
    await user.type(orgInput(), 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    await screen.findByRole('button', { name: /^Newco$/ });
    await waitFor(() => expect(screen.getByTestId('org-list')).toHaveTextContent('Newco'));
  });

  it('KILLS: relinking invalidates the organization sheets and the organizations list', async () => {
    const { user } = renderSheet(true);
    await startEditing(user);
    const before = calls.filter((c) => c.method === 'GET' && c.path === '/api/organizations').length;
    await user.type(orgInput(), 'Beta');
    await user.click(await screen.findByRole('option', { name: /Beta Labs/ }));
    await screen.findByRole('button', { name: 'Beta Labs' });
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/organizations').length).toBeGreaterThan(before));
  });
});
