// Adversarial review probes for the notes renderer on text attribute values. Titles start with KILLS (a real defect,
// written with it.fails so the suite stays green until the fix lands), CONFIRMS (an attack that failed), or ACCEPTED (a
// hostile input that is fine per the contract). Nothing here changes application code.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NoteText } from '../src/components/attributes';
import { PersonSheet } from '../src/screens/RecordSheets';
import { Router } from './helpers';

vi.mock('../src/lib/ui', () => ({
  useUI: () => ({
    setSelectedRecord: () => {},
    pushToast: () => {},
    toasts: [],
    dismissToast: () => {},
  }),
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

const view = (value: string) => render(<NoteText value={value} />).container;
const texts = (nodes: ArrayLike<Element>) => Array.from(nodes).map((node) => node.textContent);

describe('injection and markup', () => {
  it('CONFIRMS: script and img tags stay literal text', () => {
    const value = '<script>window.__pwn = 1</script>\n<img src=x onerror="window.__pwn = 2">';
    const root = view(value);
    expect(root.querySelector('script, img')).toBeNull();
    expect(root.querySelectorAll('p')).toHaveLength(2);
    expect(root.querySelectorAll('p')[0]!.textContent).toBe('<script>window.__pwn = 1</script>');
    expect(root.querySelectorAll('p')[1]!.textContent).toBe('<img src=x onerror="window.__pwn = 2">');
    expect((window as any).__pwn).toBeUndefined();
    expect(root.innerHTML).toContain('&lt;script&gt;');
  });

  it('CONFIRMS: HTML entities are not decoded', () => {
    const root = view('Fish &amp; chips &lt;b&gt;x&lt;/b&gt; &#60;i&#62;');
    expect(root.textContent).toBe('Fish &amp; chips &lt;b&gt;x&lt;/b&gt; &#60;i&#62;');
    expect(root.querySelector('b, i')).toBeNull();
  });

  it('CONFIRMS: javascript URLs, markdown links, and autolinkable URLs never become anchors', () => {
    const root = view(
      ['javascript:alert(1)', '[click](javascript:alert(1))', '[x](https://evil.example)', 'https://example.com/a?b=c', 'www.example.com', 'mail me@example.com', '<a href="https://x.example">x</a>'].join('\n'),
    );
    expect(root.querySelector('a, [href], [onclick], [onerror]')).toBeNull();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(root.textContent).toContain('[click](javascript:alert(1))');
    expect(root.textContent).toContain('https://example.com/a?b=c');
  });

  it('CONFIRMS: a hostile label line keeps the markup literal inside the label span', () => {
    const root = view('Tom & <b>Jerry: <i>hi</i>');
    expect(root.querySelector('b, i')).toBeNull();
    // "<" is not an allowed label character, so this is a plain line.
    expect(root.querySelector('.note__label')).toBeNull();
    expect(root.textContent).toBe('Tom & <b>Jerry: <i>hi</i>');
  });

  it('CONFIRMS: a label with a markup rest keeps the rest literal', () => {
    const root = view('Source: <img src=x onerror=alert(1)>');
    expect(root.querySelector('.note__label')).toHaveTextContent('Source:');
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toBe('Source: <img src=x onerror=alert(1)>');
  });

  it('CONFIRMS: bullet items stay literal text', () => {
    const root = view('- <script>x</script>\n* **bold** [l](http://a.b)\n• # not a heading');
    expect(root.querySelector('script, strong, a, h1')).toBeNull();
    expect(texts(root.querySelectorAll('li'))).toEqual(['<script>x</script>', '**bold** [l](http://a.b)', '# not a heading']);
  });
});

describe('label line edge cases', () => {
  const label = (value: string) => view(value).querySelector('.note__label');

  it('CONFIRMS: the 40 character bound is exact', () => {
    expect(label(`A${'b'.repeat(39)}: x`)).not.toBeNull();
    expect(label(`A${'b'.repeat(40)}: x`)).toBeNull();
  });

  it('CONFIRMS: a one capital letter label is a label', () => {
    expect(label('A: x')).toHaveTextContent('A:');
  });

  it('CONFIRMS: punctuation in the label part keeps the line plain', () => {
    for (const text of ['Mr. Smith: x', 'Stage, round: x', 'What?: x', 'Hi!: x', 'A;B: x', "O'Brien: x", 'A_B: x', 'A#1: x', 'A+B: x', 'A@B: x', 'A"B": x']) {
      expect(label(text)).toBeNull();
    }
  });

  it('CONFIRMS: the label is cut at the first colon and a second colon in the rest is fine', () => {
    const root = view('Time: 10:30: sharp');
    expect(root.querySelector('.note__label')!.textContent).toBe('Time:');
    expect(root.querySelector('p')!.textContent).toBe('Time: 10:30: sharp');
    // A double colon leaves a rest with no space after the first colon.
    expect(label('Note:: x')).toBeNull();
    // A label that would need to include a colon is rejected.
    expect(label('A:B: x')).toBeNull();
  });

  it('CONFIRMS: a colon with no space after it is plain, and whitespace only after it is plain', () => {
    expect(label('Label:rest')).toBeNull();
    expect(label('Label:   ')).toBeNull();
    expect(label('Label:\t')).toBeNull();
    expect(label('Label:')).toBeNull();
  });

  it('CONFIRMS: a tab after the colon still counts as whitespace before the rest', () => {
    expect(label('Label:\trest')).toHaveTextContent('Label:');
  });

  it('CONFIRMS: a leading colon or a leading space is plain', () => {
    expect(label(': x')).toBeNull();
    expect(label(' Stage: x')).toBeNull();
    expect(label('\tStage: x')).toBeNull();
  });

  it('ACCEPTED: a label line inside a bullet gets no label styling', () => {
    // The contract only labels paragraph lines; a bullet item is shown as written.
    const root = view('- Stage: seed');
    expect(root.querySelector('.note__label')).toBeNull();
    expect(root.querySelector('li')!.textContent).toBe('Stage: seed');
  });

  it('ACCEPTED: an all caps and a spaced label are labels, since the contract only asks for a capital start', () => {
    expect(label('ABC: x')).toHaveTextContent('ABC:');
    expect(label('Stage : x')!.textContent).toBe('Stage :');
    expect(label('A - B (c) / d & e: x')).not.toBeNull();
  });

  it('CONFIRMS: the label span holds the colon and the rest keeps its leading space', () => {
    const p = view('Stage:  two spaces').querySelector('p')!;
    expect(p.querySelector('.note__label')!.textContent).toBe('Stage:');
    expect(p.textContent).toBe('Stage:  two spaces');
  });

  it('CONFIRMS: a very long first line without a colon in range is plain', () => {
    expect(label(`${'A'.repeat(100)}: x`)).toBeNull();
    expect(label(`Short line ${'x'.repeat(100)}: tail`)).toBeNull();
  });

  it('CONFIRMS: only the first colon decides, so a lowercase first segment is plain even if a later one is capitalised', () => {
    expect(label('see Stage: x')).toBeNull();
    expect(label('http://x.example: y')).toBeNull();
  });
});

describe('bullet and gap structure', () => {
  it('CONFIRMS: each of the three markers makes a list item with the marker removed', () => {
    for (const marker of ['- ', '* ', '• ']) {
      const root = view(`${marker}item`);
      expect(root.querySelectorAll('ul')).toHaveLength(1);
      expect(root.querySelector('li')!.textContent).toBe('item');
    }
  });

  it('CONFIRMS: a marker without its space, or a different marker, is a paragraph', () => {
    for (const text of ['-item', '*item', '•item', '+ item', '– item', '-', '*', '•', '**bold**']) {
      const root = view(text);
      expect(root.querySelector('ul')).toBeNull();
      expect(root.querySelector('p')!.textContent).toBe(text);
    }
  });

  it('ACCEPTED: a lone "- " with nothing after it renders one empty list item', () => {
    // The contract says a line starting with "- " is a list item, so it is one, with empty text. The line is not blank
    // because trim() leaves the dash. It is harmless: a stray bullet dot, and the user wrote it.
    const root = view('One\n- \nTwo');
    expect(root.querySelectorAll('li')).toHaveLength(1);
    expect(root.querySelector('li')!.textContent).toBe('');
    expect(root.querySelectorAll('p')).toHaveLength(2);
  });

  it('ACCEPTED: a value of only "- " renders a single empty bullet', () => {
    const root = view('- ');
    expect(root.querySelectorAll('li')).toHaveLength(1);
    expect(root.querySelector('li')!.textContent).toBe('');
  });

  it('CONFIRMS: mixed markers on consecutive lines are one list', () => {
    const root = view('- a\n* b\n• c\n- d');
    expect(root.querySelectorAll('ul')).toHaveLength(1);
    expect(texts(root.querySelectorAll('li'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('CONFIRMS: bullet, blank, bullet is two lists with the gap on the second only', () => {
    const lists = view('- a\n\n- b').querySelectorAll('ul');
    expect(lists).toHaveLength(2);
    expect(lists[0]).not.toHaveClass('note__gap');
    expect(lists[1]).toHaveClass('note__gap');
  });

  it('CONFIRMS: a gap is never on the first group, even after leading blank lines', () => {
    const root = view('\n\n\nFirst\n\nSecond');
    const lines = root.querySelectorAll('p');
    expect(lines[0]).not.toHaveClass('note__gap');
    expect(lines[1]).toHaveClass('note__gap');
    const list = view('\n\n- a').querySelector('ul')!;
    expect(list).not.toHaveClass('note__gap');
  });

  it('CONFIRMS: several blank lines, including whitespace only ones, count as one gap and add no elements', () => {
    const root = view('A\n\n\n   \n\t\n\nB');
    const lines = root.querySelectorAll('p');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toHaveClass('note__gap');
    expect(root.querySelector('.note')!.children).toHaveLength(2);
  });

  it('CONFIRMS: a trailing blank line adds no gap or element', () => {
    const root = view('A\n\n\n');
    expect(root.querySelector('.note')!.children).toHaveLength(1);
    expect(root.querySelector('.note__gap')).toBeNull();
  });

  it('CONFIRMS: a value of only blank lines renders an empty note with no paragraphs or items', () => {
    const root = view('\n  \n\n');
    expect(root.querySelector('.note')).not.toBeNull();
    expect(root.querySelector('p, ul, li')).toBeNull();
    expect(root.textContent).toBe('');
  });

  it('ACCEPTED: an indented bullet is a plain paragraph', () => {
    // The contract says lines "starting with" a marker, and an indented line does not start with one.
    const root = view('  - a');
    expect(root.querySelector('ul')).toBeNull();
    expect(root.querySelector('p')!.textContent).toBe('  - a');
  });

  it('CONFIRMS: a paragraph between two bullet lines splits them into two lists', () => {
    const root = view('- a\nmiddle\n- b');
    expect(root.querySelectorAll('ul')).toHaveLength(2);
    expect(root.querySelectorAll('p')).toHaveLength(1);
    expect(root.querySelectorAll('.note__gap')).toHaveLength(0);
  });

  it('CONFIRMS: extra spaces after the marker are kept in the item', () => {
    expect(view('-   a').querySelector('li')!.textContent).toBe('  a');
  });

  it('ACCEPTED: an empty bullet in the middle of a list stays inside the one list', () => {
    const root = view('- a\n- \n- b');
    expect(root.querySelectorAll('ul')).toHaveLength(1);
    expect(texts(root.querySelectorAll('li'))).toEqual(['a', '', 'b']);
  });

  it('KILLS, fixed: Windows line endings leak a carriage return into the rendered text', () => {
    // The contract says the value splits on line breaks. A CRLF value is a stored value like any other, and a \r must not
    // end up in the rendered paragraph or list item text.
    const root = view('Stage: seed\r\nSecond\r\n- a\r\n- b\r\n\r\nLast');
    expect(root.textContent).not.toContain('\r');
  });

  it('CONFIRMS: a CRLF "Label:" line with nothing after the colon stays plain', () => {
    // The stray \r counts as whitespace, not as a rest, so the line is not a label.
    const root = view('Label:\r\nNext');
    expect(root.querySelector('.note__label')).toBeNull();
  });

  it('KILLS, fixed: a CRLF label line still carries its label', () => {
    const root = view('Stage: seed\r\n');
    expect(root.querySelector('.note__label')).toHaveTextContent('Stage:');
    expect(root.querySelector('p')!.textContent).toBe('Stage: seed');
  });
});

describe('unicode', () => {
  const label = (value: string) => view(value).querySelector('.note__label');

  it('CONFIRMS: a precomposed accented capital starts a label', () => {
    expect(label('Équipe: x')).toHaveTextContent('Équipe:');
    expect(label('Ñandú: x')).not.toBeNull();
    expect(label('Ünïcode Ñame: x')).not.toBeNull();
  });

  it('CONFIRMS: a non Latin capital starts a label', () => {
    expect(label('Привет: x')).not.toBeNull();
    expect(label('Σοφία: x')).not.toBeNull();
  });

  it('CONFIRMS: a label starting with a digit is plain, and digits later in the label are fine', () => {
    expect(label('1st round: x')).toBeNull();
    expect(label('2024: x')).toBeNull();
    expect(label('Round 2: x')).not.toBeNull();
  });

  it('CONFIRMS: RTL text renders as literal text without a label', () => {
    const root = view('שלום עולם: טקסט\nمرحبا');
    expect(root.querySelector('.note__label')).toBeNull();
    expect(root.querySelectorAll('p')).toHaveLength(2);
    expect(root.textContent).toBe('שלום עולםטקסט'.length ? 'שלום עולם: טקסטمرحبا' : '');
  });

  it('CONFIRMS: a line of only a bullet glyph is a paragraph', () => {
    const root = view('•');
    expect(root.querySelector('ul')).toBeNull();
    expect(root.querySelector('p')!.textContent).toBe('•');
  });

  it('ACCEPTED: a lone "• " is an empty bullet like a lone "- "', () => {
    expect(view('A\n• \nB').querySelectorAll('li')).toHaveLength(1);
  });

  it('CONFIRMS: emoji and astral characters pass through intact', () => {
    const root = view('Stage: 🚀 seed\n- 𝒜 item');
    expect(root.textContent).toBe('Stage: 🚀 seed𝒜 item');
  });

  it('KILLS, fixed: a decomposed (NFD) accented label is treated as a label', () => {
    // "Équipe" typed on a macOS keyboard or pasted from a file can be E + U+0301. The contract says a label contains no
    // other punctuation than spaces, parentheses, slashes, ampersands, or hyphens, and a combining accent is not punctuation.
    // The regex only allows \p{L} and \p{N}, so the combining mark (category M) turns the label into a plain line.
    const nfd = 'Équipe: x'.normalize('NFD');
    expect(nfd).not.toBe('Équipe: x');
    expect(view(nfd).querySelector('.note__label')).not.toBeNull();
  });
});

describe('very long values', () => {
  it('CONFIRMS: a 2000 character single line is one paragraph with the wrapping rules in place', () => {
    const long = 'x'.repeat(2000);
    const root = view(long);
    expect(root.querySelectorAll('p')).toHaveLength(1);
    expect(root.querySelector('p')!.textContent).toBe(long);
    expect(root.querySelector('p')!.className).toBe('note__line');
  });

  it('CONFIRMS: the note is capped at 62ch and sits under a container that breaks long words', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/components.css'), 'utf8');
    expect(css).toMatch(/\.note\s*\{[^}]*max-width:\s*62ch/);
    expect(css).toMatch(/\.field__value\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.note__line,\s*\.note__list li\s*\{[^}]*white-space:\s*pre-wrap/);
    // No rule on the note turns off wrapping.
    expect(css).not.toMatch(/\.note[^{]*\{[^}]*white-space:\s*(nowrap|pre)\s*;/);
  });

  it('CONFIRMS: 200 lines render with no truncation', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `Line ${index + 1}`);
    const root = view(lines.join('\n'));
    expect(root.querySelectorAll('p')).toHaveLength(200);
    expect(root.querySelectorAll('p')[199]!.textContent).toBe('Line 200');
  });

  it('CONFIRMS: 200 bullets render as one list of 200 items', () => {
    const root = view(Array.from({ length: 200 }, (_, index) => `- item ${index + 1}`).join('\n'));
    expect(root.querySelectorAll('ul')).toHaveLength(1);
    expect(root.querySelectorAll('li')).toHaveLength(200);
  });

  it('CONFIRMS: the list is not capped narrower than the paragraphs and uses the same wrapping on items', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/components.css'), 'utf8');
    expect(css).toMatch(/\.note__list\s*\{[^}]*padding-left/);
    expect(css).not.toMatch(/\.note__list[^{]*\{[^}]*overflow:\s*hidden/);
  });
});

describe('on the record sheet', () => {
  it('CONFIRMS: the pencil opens a textarea with the byte identical stored text and a blur sends no request', async () => {
    const stored = 'Stage: <script>x</script>\n\n- [a](javascript:1)\n* **b**\n• c\n\n  indented\n\nÉquipe: ünï\t\ttab\n🚀';
    values = { 'research-notes': stored };
    const { user } = renderSheet();
    await screen.findByText('Research notes', { selector: 'dt' });
    const row = await waitFor(() => {
      const found = rowOf('Research notes');
      expect(found.querySelector('.note')).not.toBeNull();
      return found;
    });
    expect(row.querySelector('script, a')).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Edit research notes' }));
    const box = screen.getByRole('textbox', { name: 'Research notes' }) as HTMLTextAreaElement;
    expect(box.value).toBe(stored);
    expect(box.value.length).toBe(stored.length);
    await user.click(screen.getByText('Fields'));
    expect(patches()).toHaveLength(0);
    expect(screen.queryByRole('textbox', { name: 'Research notes' })).not.toBeInTheDocument();
  });

  it('CONFIRMS: a CRLF stored value opens byte identical in the textarea', async () => {
    const stored = 'Stage: seed\r\n- a\r\n\r\nLast';
    values = { 'research-notes': stored };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit research notes' }));
    // A textarea value normalises line breaks to \n in the DOM, so compare after the same normalisation.
    expect((screen.getByRole('textbox', { name: 'Research notes' }) as HTMLTextAreaElement).value.replace(/\r\n/g, '\n')).toBe(
      stored.replace(/\r\n/g, '\n'),
    );
  });

  it('KILLS, fixed: opening and leaving a stored value with surrounding whitespace sends a PATCH that rewrites it', async () => {
    // The contract says the pencil opens the exact stored text and that saving an untouched draft changes nothing.
    // The commit trims the draft, so a stored value with a trailing newline (as written through the API) differs from the
    // trimmed draft and an untouched blur sends a PATCH that changes the stored text.
    values = { 'research-notes': 'Stage: seed\n- a\n' };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit research notes' }));
    await user.click(screen.getByText('Fields'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patches()).toHaveLength(0);
  });

  it('CONFIRMS: a value with no surrounding whitespace, untouched, sends no PATCH', async () => {
    values = { 'research-notes': 'Stage: seed\n\n\n- a  \n\nend' };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit research notes' }));
    await user.click(screen.getByText('Fields'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patches()).toHaveLength(0);
  });

  it('CONFIRMS: the textarea edit path stays a plain textarea, not the notes markup', async () => {
    values = { 'research-notes': 'Stage: seed\n- a' };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit research notes' }));
    const row = rowOf('Research notes');
    expect(row.querySelector('.note')).toBeNull();
    expect(row.querySelector('textarea')).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(rowOf('Research notes').querySelector('.note')).not.toBeNull();
  });

  it('CONFIRMS: editing a note and saving re-renders it as notes', async () => {
    values = { 'research-notes': 'Old' };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit research notes' }));
    const box = screen.getByRole('textbox', { name: 'Research notes' });
    await user.clear(box);
    await user.type(box, 'Stage: new{Enter}- a{Enter}- b');
    await user.click(screen.getByText('Fields'));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.body.fields).toEqual({ 'attr:research-notes': 'Stage: new\n- a\n- b' });
    await waitFor(() => expect(rowOf('Research notes').querySelectorAll('li')).toHaveLength(2));
    expect(rowOf('Research notes').querySelector('.note__label')).toHaveTextContent('Stage:');
  });
});

describe('regression for other attribute kinds', () => {
  it('CONFIRMS: number and money rows have no note element, even with note shaped values', async () => {
    values = { 'funds-managed': 12, 'minimum-check-size': { amount: 5000, currency: 'USD' } };
    renderSheet();
    await screen.findByText('Funds managed', { selector: 'dt' });
    await waitFor(() => expect(rowOf('Funds managed')).toHaveTextContent('12'));
    expect(rowOf('Funds managed').querySelector('.note')).toBeNull();
    await waitFor(() => expect(rowOf('Minimum check size')).toHaveTextContent('$5.0K'));
    expect(rowOf('Minimum check size').querySelector('.note')).toBeNull();
    expect(rowOf('Maximum check size').querySelector('.note')).toBeNull();
  });

  it('CONFIRMS: an empty text value shows the muted Not set and no note element', async () => {
    renderSheet();
    await screen.findByText('Research notes', { selector: 'dt' });
    const row = rowOf('Research notes');
    expect(within(row).getByText('Not set')).toHaveClass('muted');
    expect(row.querySelector('.note')).toBeNull();
    expect(row.querySelector('ul, li')).toBeNull();
  });

  it('CONFIRMS: a text value saved as the empty string by clearing returns to Not set', async () => {
    values = { 'research-notes': 'x' };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Edit research notes' }));
    await user.clear(screen.getByRole('textbox', { name: 'Research notes' }));
    await user.click(screen.getByText('Fields'));
    await waitFor(() => expect(within(rowOf('Research notes')).getByText('Not set')).toHaveClass('muted'));
    expect(rowOf('Research notes').querySelector('.note')).toBeNull();
  });
});
