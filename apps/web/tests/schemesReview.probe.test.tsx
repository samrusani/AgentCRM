// Adversarial review probes for the color schemes wave (docs/design.md "Color schemes" and the Appearance bullet).
// Names start with KILLS (a real defect, written as it.fails so the suite stays green and flips loudly when fixed),
// CONFIRMS (a suspected defect that does not exist; the probe pins the correct behavior), or ACCEPTED (odd but
// contract-consistent). Nothing here changes application code.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GeneralSettings } from '../src/screens/Settings';
import { UIProvider, useUI, readScheme, SCHEMES, type SchemeSetting } from '../src/lib/ui';
import { Router } from './helpers';

const WEB = path.join(__dirname, '..');
const tokens = readFileSync(path.join(WEB, 'src/styles/tokens.css'), 'utf8');
const screensCss = readFileSync(path.join(WEB, 'src/styles/screens.css'), 'utf8');
const designDoc = readFileSync(path.join(WEB, '../../docs/design.md'), 'utf8');

// ---- a small cascade engine for tokens.css (only :root selectors with [data-x='v'] and :not([data-x='v'])) ----
interface Rule {
  selector: string;
  decls: Record<string, string>;
  media: boolean;
  order: number;
}

function parseRules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let order = 0;
  const walk = (src: string, media: boolean) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) return;
      const header = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (depth > 0 && j < src.length) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') depth -= 1;
        j += 1;
      }
      const body = src.slice(open + 1, j - 1);
      if (header.startsWith('@media')) walk(body, header.includes('prefers-color-scheme: dark'));
      else {
        const decls: Record<string, string> = {};
        for (const m of body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) decls[m[1]!] = m[2]!.trim();
        for (const selector of header.split(',')) rules.push({ selector: selector.trim(), decls, media, order: order++ });
      }
      i = j;
    }
  };
  walk(text, false);
  return rules;
}

const RULES = parseRules(tokens);

interface State {
  scheme: string | null;
  theme: 'light' | 'dark' | null;
  systemDark: boolean;
}

function attrOf(state: State, name: string): string | null {
  if (name === 'scheme') return state.scheme;
  if (name === 'theme') return state.theme;
  return null;
}

// Returns specificity (id, class-ish) as a number, or null when the selector does not match.
function match(selector: string, state: State): number | null {
  if (!selector.startsWith(':root')) return null;
  let rest = selector.slice(':root'.length);
  let spec = 1;
  while (rest.length > 0) {
    let m = /^\[data-(\w+)='([\w-]+)'\]/.exec(rest);
    if (m) {
      if (attrOf(state, m[1]!) !== m[2]) return null;
      spec += 1;
      rest = rest.slice(m[0].length);
      continue;
    }
    m = /^:not\(\[data-(\w+)='([\w-]+)'\]\)/.exec(rest);
    if (m) {
      if (attrOf(state, m[1]!) === m[2]) return null;
      spec += 1;
      rest = rest.slice(m[0].length);
      continue;
    }
    throw new Error(`unsupported selector ${selector}`);
  }
  return spec;
}

function resolve(state: State, prop: string): string | undefined {
  let best: { spec: number; order: number; value: string } | null = null;
  for (const rule of RULES) {
    if (rule.media && !state.systemDark) continue;
    if (!(prop in rule.decls)) continue;
    const spec = match(rule.selector, state);
    if (spec === null) continue;
    if (!best || spec > best.spec || (spec === best.spec && rule.order > best.order)) {
      best = { spec, order: rule.order, value: rule.decls[prop]! };
    }
  }
  return best?.value.toLowerCase();
}

// ---- contract table, written independently of the builder's tests ----
const CONTRACT: Record<string, { light: [string, string, string]; dark: [string, string, string] }> = {
  viridian: { light: ['#15685b', '#ffffff', '#e7f2ef'], dark: ['#43b39c', '#15211e', '#1a2b27'] },
  ocean: { light: ['#155da8', '#ffffff', '#e7eef8'], dark: ['#64a9ea', '#0e1a28', '#16222f'] },
  indigo: { light: ['#4f46b5', '#ffffff', '#ebebf9'], dark: ['#9a97ed', '#14142b', '#1b1b31'] },
  orchid: { light: ['#79309f', '#ffffff', '#f2e9f8'], dark: ['#c48ae0', '#220e2e', '#251831'] },
  rose: { light: ['#a62860', '#ffffff', '#f8e8ef'], dark: ['#e487ae', '#2b0f1c', '#2b1620'] },
  ember: { light: ['#9c4a10', '#ffffff', '#f7ece2'], dark: ['#e09560', '#27160a', '#2a1d12'] },
  graphite: { light: ['#3d4654', '#ffffff', '#e9ecf1'], dark: ['#c3ccda', '#161a20', '#232935'] },
};
const IDS = Object.keys(CONTRACT);

const STATES: Array<{ name: string; theme: State['theme']; systemDark: boolean; dark: boolean }> = [
  { name: 'system light, no data-theme', theme: null, systemDark: false, dark: false },
  { name: 'system dark, no data-theme', theme: null, systemDark: true, dark: true },
  { name: 'forced light under system light', theme: 'light', systemDark: false, dark: false },
  { name: 'forced light under system dark', theme: 'light', systemDark: true, dark: false },
  { name: 'forced dark under system light', theme: 'dark', systemDark: false, dark: true },
  { name: 'forced dark under system dark', theme: 'dark', systemDark: true, dark: true },
];

const SURFACE_PROPS = ['--shell', '--bg', '--surface', '--surface-raised', '--ink', '--ink-muted', '--line', '--warn', '--warn-tint', '--danger', '--danger-tint', '--shadow-sm', '--shadow-md', '--shadow-lg'];

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function ratio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('color scheme cascade', () => {
  it.each(IDS.flatMap((id) => STATES.map((s) => [id, s] as const)))('CONFIRMS: %s resolves the contract accents in %o', (id, s) => {
    const row = CONTRACT[id]!;
    const want = s.dark ? row.dark : row.light;
    const state: State = { scheme: id === 'viridian' ? null : id, theme: s.theme, systemDark: s.systemDark };
    expect([resolve(state, '--accent'), resolve(state, '--on-accent'), resolve(state, '--accent-tint')]).toEqual(want);
  });

  it('CONFIRMS: a scheme changes nothing but the three accent tokens in any state (surfaces, ink, lines, warn, danger, shadows)', () => {
    for (const id of IDS) {
      for (const s of STATES) {
        const base: State = { scheme: null, theme: s.theme, systemDark: s.systemDark };
        const withScheme: State = { ...base, scheme: id === 'viridian' ? null : id };
        for (const prop of SURFACE_PROPS) expect(resolve(withScheme, prop), `${id} ${s.name} ${prop}`).toBe(resolve(base, prop));
      }
    }
  });

  it('CONFIRMS: every rule that mentions data-scheme sets only --accent, --on-accent and --accent-tint', () => {
    const schemeRules = RULES.filter((r) => r.selector.includes('data-scheme'));
    expect(schemeRules).toHaveLength(6 * 3);
    for (const rule of schemeRules) expect(Object.keys(rule.decls).sort(), rule.selector).toEqual(['--accent', '--accent-tint', '--on-accent']);
  });

  it('CONFIRMS: an unknown data-scheme value matches no block and keeps the Viridian base in every state', () => {
    for (const s of STATES) {
      const unknown: State = { scheme: 'neon', theme: s.theme, systemDark: s.systemDark };
      const viridian: State = { scheme: null, theme: s.theme, systemDark: s.systemDark };
      for (const prop of ['--accent', '--on-accent', '--accent-tint']) expect(resolve(unknown, prop)).toBe(resolve(viridian, prop));
    }
  });

  it('CONFIRMS: swatch variables follow the appearance only and never the chosen scheme', () => {
    for (const s of STATES) {
      for (const id of IDS) {
        const want = (s.dark ? CONTRACT[id]!.dark : CONTRACT[id]!.light)[0];
        for (const chosen of [null, 'rose', 'graphite']) {
          expect(resolve({ scheme: chosen, theme: s.theme, systemDark: s.systemDark }, `--swatch-${id}`)).toBe(want);
        }
      }
    }
  });

  it('CONFIRMS: the css table equals the table printed in docs/design.md (case-insensitive)', () => {
    const section = designDoc.slice(designDoc.indexOf('### Color schemes'), designDoc.indexOf('Contrast floors hold'));
    const rows = [...section.matchAll(/^\| (\w+)(?: \(default\))? \| (#\w{6}) \| (#\w{6}) \| (#\w{6}) \| (#\w{6}) \| (#\w{6}) \| (#\w{6}) \|$/gm)];
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      const id = r[1]!.toLowerCase();
      expect([r[2], r[3], r[4]].map((h) => h!.toLowerCase())).toEqual(CONTRACT[id]!.light);
      expect([r[5], r[6], r[7]].map((h) => h!.toLowerCase())).toEqual(CONTRACT[id]!.dark);
    }
  });
});

describe('color scheme contrast', () => {
  const SURF = { light: { surface: '#ffffff', bg: '#f4f5f8' }, dark: { surface: '#1c2027', bg: '#15181d' } };

  it('CONFIRMS: the base surfaces used for the check are the ones tokens.css really ships', () => {
    expect(resolve({ scheme: null, theme: 'light', systemDark: false }, '--surface')).toBe(SURF.light.surface);
    expect(resolve({ scheme: null, theme: 'light', systemDark: false }, '--bg')).toBe(SURF.light.bg);
    expect(resolve({ scheme: null, theme: 'dark', systemDark: false }, '--surface')).toBe(SURF.dark.surface);
    expect(resolve({ scheme: null, theme: 'dark', systemDark: false }, '--bg')).toBe(SURF.dark.bg);
  });

  it.each(IDS.flatMap((id) => STATES.map((s) => [id, s] as const)))('CONFIRMS: %s holds the four 4.5:1 floors in %o', (id, s) => {
    const state: State = { scheme: id === 'viridian' ? null : id, theme: s.theme, systemDark: s.systemDark };
    const accent = resolve(state, '--accent')!;
    const on = resolve(state, '--on-accent')!;
    const tint = resolve(state, '--accent-tint')!;
    const surface = resolve(state, '--surface')!;
    const bg = resolve(state, '--bg')!;
    expect(ratio(accent, surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(accent, bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(on, accent)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(accent, tint)).toBeGreaterThanOrEqual(4.5);
  });

  it('CONFIRMS: the contract sentence "range 5.31 to 10.99" is exact over the four floors', () => {
    let min = 99;
    let max = 0;
    for (const id of IDS) {
      for (const mode of ['light', 'dark'] as const) {
        const [a, o, t] = CONTRACT[id]![mode];
        for (const r of [ratio(a, SURF[mode].surface), ratio(a, SURF[mode].bg), ratio(o, a), ratio(a, t)]) {
          min = Math.min(min, r);
          max = Math.max(max, r);
        }
      }
    }
    expect(min.toFixed(2)).toBe('5.31');
    expect(max.toFixed(2)).toBe('10.99');
  });

  it('CONFIRMS: the primary button hover step (accent 88% + black) keeps on-accent text at 4.5:1 in every scheme and appearance', () => {
    expect(readFileSync(path.join(WEB, 'src/styles/components.css'), 'utf8')).toContain('color-mix(in srgb, var(--accent) 88%, black)');
    const darken = (h: string) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * 0.88).toString(16).padStart(2, '0')).join('');
    for (const id of IDS) {
      for (const mode of ['light', 'dark'] as const) {
        const [a, o] = CONTRACT[id]![mode];
        expect(ratio(o, darken(a)), `${id} ${mode}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('readScheme and setScheme under hostile input', () => {
  function Harness() {
    const { scheme, setScheme } = useUI();
    return (
      <>
        <span data-testid="scheme">{scheme}</span>
        <button type="button" onClick={() => setScheme('<img src=x onerror=alert(1)>' as unknown as SchemeSetting)}>
          hostile
        </button>
      </>
    );
  }

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-scheme');
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-scheme');
  });

  const HOSTILE = ['OCEAN', ' ocean', 'ocean ', 'ocean"><script>', '__proto__', 'constructor', 'toString', '', 'x'.repeat(100_000), 'viridian\u0000', 'null', 'undefined'];

  it.each(HOSTILE.map((v) => [v.length > 40 ? `${v.length}-char string` : JSON.stringify(v), v]))(
    'CONFIRMS: stored %s falls back to viridian and never reaches the attribute',
    (_label, value) => {
      window.localStorage.setItem('agentcrm.scheme', value);
      expect(readScheme()).toBe('viridian');
      render(
        <UIProvider>
          <Harness />
        </UIProvider>,
      );
      expect(screen.getByTestId('scheme')).toHaveTextContent('viridian');
      expect(document.documentElement).not.toHaveAttribute('data-scheme');
    },
  );

  it('CONFIRMS: every valid id round-trips through storage, and a blocked storage still falls back', () => {
    for (const id of SCHEMES) {
      window.localStorage.setItem('agentcrm.scheme', id);
      expect(readScheme()).toBe(id);
    }
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readScheme()).toBe('viridian');
    spy.mockRestore();
  });

  it('KILLS, fixed: setScheme ignores a value outside the seven ids, so the attribute and storage never carry an unvalidated string', async () => {
    const user = userEvent.setup();
    render(
      <UIProvider>
        <Harness />
      </UIProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'hostile' }));
    // Contract: the attribute must only ever carry one of the six non-default ids; setScheme validates against SCHEMES.
    expect(document.documentElement.getAttribute('data-scheme')).toBeNull();
    expect(window.localStorage.getItem('agentcrm.scheme')).toBeNull();
  });

  it('KILLS, fixed: the index.html pre-paint script restores a stored scheme, validated against the six non-default ids, so a reload never flashes Viridian', () => {
    const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
    expect(html).toContain('agentcrm.scheme');
    expect(html).toContain("['ocean', 'indigo', 'orchid', 'rose', 'ember', 'graphite'].indexOf(scheme)");
  });
});

describe('Settings color group', () => {
  function renderGeneral(extra?: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <UIProvider>
          <Router>
            <GeneralSettings />
            {extra}
          </Router>
        </UIProvider>
      </QueryClientProvider>,
    );
  }

  function Outside() {
    const { setScheme } = useUI();
    return (
      <button type="button" onClick={() => setScheme('graphite')}>
        outside graphite
      </button>
    );
  }

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-scheme');
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-scheme');
  });

  it('CONFIRMS: exactly seven radios in the Color group, defaulting to Viridian, appearance group untouched', () => {
    renderGeneral();
    const color = screen.getByRole('radiogroup', { name: 'Color' });
    expect(within(color).getAllByRole('radio')).toHaveLength(7);
    expect(within(color).getByRole('radio', { name: 'Viridian' })).toBeChecked();
    const appearance = screen.getByRole('radiogroup', { name: 'Appearance' });
    expect(within(appearance).getAllByRole('radio')).toHaveLength(3);
    expect(within(appearance).getByRole('radio', { name: 'System' })).toBeChecked();
  });

  it('CONFIRMS: the checked radio tracks state changed from outside the picker', async () => {
    const user = userEvent.setup();
    renderGeneral(<Outside />);
    await user.click(screen.getByRole('button', { name: 'outside graphite' }));
    expect(screen.getByRole('radio', { name: 'Graphite' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Viridian' })).not.toBeChecked();
  });

  it('CONFIRMS: the radio group is keyboard operable (Tab reaches it, arrows move and apply the choice)', async () => {
    const user = userEvent.setup();
    renderGeneral();
    const viridian = screen.getByRole('radio', { name: 'Viridian' });
    viridian.focus();
    expect(viridian).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Ocean' })).toBeChecked();
    expect(document.documentElement).toHaveAttribute('data-scheme', 'ocean');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Indigo' })).toBeChecked();
    expect(document.documentElement).toHaveAttribute('data-scheme', 'indigo');
  });

  it('CONFIRMS: clicking the visible name (the label) also picks the scheme', async () => {
    const user = userEvent.setup();
    renderGeneral();
    await user.click(screen.getByText('Rose'));
    expect(screen.getByRole('radio', { name: 'Rose' })).toBeChecked();
    expect(document.documentElement).toHaveAttribute('data-scheme', 'rose');
  });

  it('CONFIRMS: one muted line sits after both controls, covers the browser-only storage, and appears exactly once', () => {
    renderGeneral();
    const lines = screen.getAllByText(/This choice is stored in this browser only\./);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveClass('muted');
    const color = screen.getByRole('radiogroup', { name: 'Color' });
    expect(color.compareDocumentPosition(lines[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('CONFIRMS: the swatch input is hidden by opacity only (focusable), swatch is 18px round, ring is 2px surface + 2px accent', () => {
    const input = /\.scheme-option input\s*\{([^}]*)\}/.exec(screensCss)![1]!;
    expect(input).toContain('opacity: 0');
    expect(input).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    const swatch = /\.scheme-option__swatch\s*\{([^}]*)\}/.exec(screensCss)![1]!;
    expect(swatch).toContain('width: 18px');
    expect(swatch).toContain('height: 18px');
    expect(swatch).toContain('border-radius: 50%');
    const ring = /input:checked \+ \.scheme-option__swatch\s*\{([^}]*)\}/.exec(screensCss)![1]!;
    expect(ring).toMatch(/0 0 0 2px var\(--surface\)/);
    expect(ring).toMatch(/0 0 0 4px var\(--accent\)/);
    expect(/\.scheme-group\s*\{([^}]*)\}/.exec(screensCss)![1]).toContain('flex-wrap: wrap');
  });

  it('CONFIRMS: nothing relies on the swatch color alone (swatch is aria-hidden, every option has a text name)', () => {
    renderGeneral();
    const color = screen.getByRole('radiogroup', { name: 'Color' });
    expect(color.querySelectorAll('.scheme-option__swatch[aria-hidden="true"]')).toHaveLength(7);
  });
});

describe('repo rules for the wave', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else out.push(full);
    }
    return out;
  }
  const SRC = walk(path.join(WEB, 'src')).filter((f) => /\.(tsx?|css)$/.test(f));

  it('CONFIRMS: no hex literal in any TSX or TS under src', () => {
    for (const file of SRC.filter((f) => /\.tsx?$/.test(f))) expect(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/.test(readFileSync(file, 'utf8').replace(/&#\d+;/g, '')), file).toBe(false);
  });

  it('CONFIRMS: no component stylesheet hardcodes a Viridian accent hex, so every rule follows the scheme', () => {
    for (const file of SRC.filter((f) => f.endsWith('.css') && !f.endsWith('tokens.css'))) {
      expect(/#15685b|#43b39c|#e7f2ef|#1a2b27/i.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });

  it('CONFIRMS: no em dash and no absolute machine path in src or in the wave tests', () => {
    const files = [...SRC, path.join(WEB, 'tests/screens/colorSchemes.test.tsx'), path.join(WEB, 'tests/components/timelineClamp.test.tsx')];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text.includes('—'), file).toBe(false);
      expect(/\/Users\/|\/home\/[a-z]/.test(text), file).toBe(false);
    }
  });
});
