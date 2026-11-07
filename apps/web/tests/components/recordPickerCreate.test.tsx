import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RecordPicker, type PickedRecord, type PickerKind } from '../../src/components/RecordPicker';

// The create affordance is opt-in: a call site passes onCreate, and only organizations honor it.

const ORGS = [
  { id: 'org-1', version: 1, name: 'Acme Capital', domain: 'acme.example.com', kind: 'fund', location: null, tags: [] },
];

let searchGate: Promise<void> | null;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  searchGate = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/search') {
        if (searchGate) await searchGate;
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        return json(200, {
          people: [],
          organizations: ORGS.filter((org) => org.name.toLowerCase().includes(q)),
          opportunities: [],
        });
      }
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPicker(props: { kind?: PickerKind; onCreate?: (name: string) => Promise<PickedRecord> } = {}) {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RecordPicker kind={props.kind ?? 'organization'} label="Organization" value={null} onChange={onChange} onCreate={props.onCreate} />
    </QueryClientProvider>,
  );
  return { user, onChange, input: screen.getByRole('combobox', { name: 'Organization' }) };
}

const createName = (text: string) => `Add "${text}" as a new organization`;
const createOption = (text: string) => screen.queryByRole('option', { name: createName(text) });

describe('Record picker create option', () => {
  it('stays hidden without onCreate, even when nothing matches', async () => {
    const { user, input } = renderPicker();
    await user.type(input, 'Newco');
    expect(await screen.findByText('No organizations match this search.')).toBeInTheDocument();
    expect(createOption('Newco')).not.toBeInTheDocument();
  });

  it('stays hidden for people even when onCreate is passed', async () => {
    const onCreate = vi.fn();
    const { user } = renderPicker({ kind: 'person', onCreate });
    await user.type(screen.getByRole('combobox', { name: 'Organization' }), 'Newco');
    expect(await screen.findByText('No people match this search.')).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('waits for the search to settle, then shows after the last match', async () => {
    let release: () => void = () => {};
    searchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user, input } = renderPicker({ onCreate: vi.fn() });
    await user.type(input, 'Acme');
    expect(await screen.findByText('Searching...')).toBeInTheDocument();
    // Past the debounce the request is in flight but unanswered, so the option is still absent.
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(createOption('Acme')).not.toBeInTheDocument();
    release();
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Acme Capitalacme.example.com', createName('Acme')]);
  });

  it('shows with zero matches beside the no match note', async () => {
    const { user, input } = renderPicker({ onCreate: vi.fn() });
    await user.type(input, 'Newco');
    expect(await screen.findByText('No organizations match this search.')).toBeInTheDocument();
    expect(createOption('Newco')).toBeInTheDocument();
  });

  it('is reached by the arrow keys and wraps around', async () => {
    const { user, input } = renderPicker({ onCreate: vi.fn() });
    await user.type(input, 'Acme');
    const create = await screen.findByRole('option', { name: createName('Acme') });
    expect(create).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('{ArrowDown}');
    expect(create).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', create.id);
    await user.keyboard('{ArrowDown}');
    expect(create).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('{ArrowUp}');
    expect(create).toHaveAttribute('aria-selected', 'true');
  });

  it('still picks the first existing match on Enter', async () => {
    const onCreate = vi.fn();
    const { user, input, onChange } = renderPicker({ onCreate });
    await user.type(input, 'Acme');
    await screen.findByRole('option', { name: createName('Acme') });
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'org-1', name: 'Acme Capital' }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('creates once with the trimmed text on Enter and picks the created record', async () => {
    const created: PickedRecord = { id: 'org-new', name: 'Newco' };
    const onCreate = vi.fn(async () => created);
    const { user, input, onChange } = renderPicker({ onCreate });
    await user.type(input, '  Newco  ');
    await screen.findByRole('option', { name: createName('Newco') });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(created));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('Newco');
  });

  it('creates on click too', async () => {
    const onCreate = vi.fn(async () => ({ id: 'org-new', name: 'Newco' }));
    const { user, input, onChange } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    await user.click(await screen.findByRole('option', { name: createName('Newco') }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: 'org-new', name: 'Newco' }));
  });

  it('disables the controls and keeps the popover open while the create is pending', async () => {
    let finish: (record: PickedRecord) => void = () => {};
    const onCreate = vi.fn(
      () =>
        new Promise<PickedRecord>((resolve) => {
          finish = resolve;
        }),
    );
    const { user, input, onChange } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    const create = await screen.findByRole('option', { name: createName('Newco') });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(input).toBeDisabled());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
    expect(input).toHaveAttribute('aria-busy', 'true');
    expect(within(screen.getByRole('listbox')).getAllByRole('option').every((option) => option.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Adding organization...');
    // A second activation does nothing while the first is in flight.
    await user.click(create);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    finish({ id: 'org-new', name: 'Newco' });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: 'org-new', name: 'Newco' }));
  });

  it('shows a failure in the note line with the next step and keeps the typed text', async () => {
    const onCreate = vi.fn().mockRejectedValueOnce(new Error('The server is not reachable.')).mockResolvedValueOnce({ id: 'org-new', name: 'Newco' });
    const { user, input, onChange } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    await screen.findByRole('option', { name: createName('Newco') });
    await user.keyboard('{Enter}');
    const alert = await screen.findByRole('alert');
    // A plain error is not a 400 validation refusal, so the closing sentence is "Try again." (was "Fix the name or try again.").
    expect(alert).toHaveTextContent('The server is not reachable. Try again.');
    expect(alert).toHaveClass('picker__note');
    expect(input).toHaveValue('Newco');
    expect(input).toBeEnabled();
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    // Retrying works and picks the record.
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: 'org-new', name: 'Newco' }));
    expect(onCreate).toHaveBeenCalledTimes(2);
  });

  it('clears the failure note once the text is edited', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('A company with this name already exists.'));
    const { user, input } = renderPicker({ onCreate });
    await user.type(input, 'Newco');
    await screen.findByRole('option', { name: createName('Newco') });
    await user.keyboard('{Enter}');
    await screen.findByRole('alert');
    await user.type(input, 'x');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
