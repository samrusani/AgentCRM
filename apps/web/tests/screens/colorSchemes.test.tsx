import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GeneralSettings } from '../../src/screens/Settings';
import { UIProvider, useUI, SCHEMES } from '../../src/lib/ui';
import { Router } from '../helpers';

// Mirrors the table in docs/design.md, "Color schemes". Each row: accent, on-accent, tint for light then dark.
const TABLE: Record<string, { light: [string, string, string]; dark: [string, string, string] }> = {
  ocean: { light: ['#155da8', '#ffffff', '#e7eef8'], dark: ['#64a9ea', '#0e1a28', '#16222f'] },
  indigo: { light: ['#4f46b5', '#ffffff', '#ebebf9'], dark: ['#9a97ed', '#14142b', '#1b1b31'] },
  orchid: { light: ['#79309f', '#ffffff', '#f2e9f8'], dark: ['#c48ae0', '#220e2e', '#251831'] },
  rose: { light: ['#a62860', '#ffffff', '#f8e8ef'], dark: ['#e487ae', '#2b0f1c', '#2b1620'] },
  ember: { light: ['#9c4a10', '#ffffff', '#f7ece2'], dark: ['#e09560', '#27160a', '#2a1d12'] },
  graphite: { light: ['#3d4654', '#ffffff', '#e9ecf1'], dark: ['#c3ccda', '#161a20', '#232935'] },
};
const VIRIDIAN = { light: ['#15685b', '#ffffff', '#e7f2ef'], dark: ['#43b39c', '#15211e', '#1a2b27'] };

function Probe() {
  const { scheme, setScheme } = useUI();
  return (
    <>
      <span data-testid="scheme">{scheme}</span>
      <button type="button" onClick={() => setScheme('rose')}>
        pick rose
      </button>
      <button type="button" onClick={() => setScheme('viridian')}>
        pick viridian
      </button>
    </>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-scheme');
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-scheme');
});

describe('scheme state', () => {
  it('falls back to viridian for an unknown stored value', () => {
    window.localStorage.setItem('agentcrm.scheme', 'neon');
    render(
      <UIProvider>
        <Probe />
      </UIProvider>,
    );
    expect(screen.getByTestId('scheme')).toHaveTextContent('viridian');
    expect(document.documentElement).not.toHaveAttribute('data-scheme');
  });

  it('reads a stored scheme and applies it to the root', () => {
    window.localStorage.setItem('agentcrm.scheme', 'ocean');
    render(
      <UIProvider>
        <Probe />
      </UIProvider>,
    );
    expect(document.documentElement).toHaveAttribute('data-scheme', 'ocean');
  });

  it('setScheme writes storage and sets the attribute, and viridian removes it', async () => {
    const user = userEvent.setup();
    render(
      <UIProvider>
        <Probe />
      </UIProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'pick rose' }));
    expect(window.localStorage.getItem('agentcrm.scheme')).toBe('rose');
    expect(document.documentElement).toHaveAttribute('data-scheme', 'rose');
    await user.click(screen.getByRole('button', { name: 'pick viridian' }));
    expect(window.localStorage.getItem('agentcrm.scheme')).toBe('viridian');
    expect(document.documentElement).not.toHaveAttribute('data-scheme');
  });
});

describe('Color group in General settings', () => {
  function renderGeneral() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <UIProvider>
          <Router>
            <GeneralSettings />
          </Router>
        </UIProvider>
      </QueryClientProvider>,
    );
  }

  it('renders the seven named options, checks the stored one, and applies a click instantly', async () => {
    window.localStorage.setItem('agentcrm.scheme', 'indigo');
    const user = userEvent.setup();
    renderGeneral();
    const group = screen.getByRole('radiogroup', { name: 'Color' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.closest('label')?.textContent)).toEqual([
      'Viridian',
      'Ocean',
      'Indigo',
      'Orchid',
      'Rose',
      'Ember',
      'Graphite',
    ]);
    expect(within(group).getByRole('radio', { name: 'Indigo' })).toBeChecked();
    expect(document.documentElement).toHaveAttribute('data-scheme', 'indigo');

    await user.click(within(group).getByRole('radio', { name: 'Ember' }));
    expect(within(group).getByRole('radio', { name: 'Ember' })).toBeChecked();
    expect(document.documentElement).toHaveAttribute('data-scheme', 'ember');
    expect(window.localStorage.getItem('agentcrm.scheme')).toBe('ember');

    await user.click(within(group).getByRole('radio', { name: 'Viridian' }));
    expect(document.documentElement).not.toHaveAttribute('data-scheme');
  });
});

describe('tokens.css color schemes', () => {
  const css = readFileSync(path.join(__dirname, '../../src/styles/tokens.css'), 'utf8');

  function blocks(selectorStart: string): string[] {
    const found: string[] = [];
    let from = 0;
    for (;;) {
      const at = css.indexOf(selectorStart, from);
      if (at < 0) return found;
      const open = css.indexOf('{', at);
      const close = css.indexOf('}', open);
      found.push(css.slice(open + 1, close));
      from = close;
    }
  }

  function decls(block: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const match of block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) out[match[1]!] = match[2]!.trim();
    return out;
  }

  it('lists the seven scheme ids and no block exists for viridian', () => {
    expect([...SCHEMES]).toEqual(['viridian', ...Object.keys(TABLE)]);
    expect(css).not.toContain("data-scheme='viridian'");
  });

  it.each(Object.keys(TABLE))('%s has light, system dark, and forced dark blocks with the design hex values', (id) => {
    const row = TABLE[id]!;
    const light = blocks(`:root[data-scheme='${id}'] {`);
    const systemDark = blocks(`:root[data-scheme='${id}']:not([data-theme='light'])`);
    const forcedDark = blocks(`:root[data-scheme='${id}'][data-theme='dark']`);
    expect(light).toHaveLength(1);
    expect(systemDark).toHaveLength(1);
    expect(forcedDark).toHaveLength(1);
    const expectLight = { '--accent': row.light[0], '--on-accent': row.light[1], '--accent-tint': row.light[2] };
    const expectDark = { '--accent': row.dark[0], '--on-accent': row.dark[1], '--accent-tint': row.dark[2] };
    // Only the three accent tokens may appear, so a scheme can never restyle surfaces.
    expect(decls(light[0]!)).toEqual(expectLight);
    expect(decls(systemDark[0]!)).toEqual(expectDark);
    expect(decls(forcedDark[0]!)).toEqual(expectDark);
  });

  it('keeps the swatch variables equal to each scheme accent in both appearances', () => {
    const all = { viridian: VIRIDIAN, ...TABLE } as Record<string, { light: string[]; dark: string[] }>;
    const rootLight = decls(blocks(':root {')[0]!);
    const systemDark = decls(blocks(":root:not([data-theme='light'])")[0]!);
    const forcedDark = decls(blocks(":root[data-theme='dark']")[0]!);
    for (const [id, row] of Object.entries(all)) {
      expect(rootLight[`--swatch-${id}`]).toBe(row.light[0]);
      expect(systemDark[`--swatch-${id}`]).toBe(row.dark[0]);
      expect(forcedDark[`--swatch-${id}`]).toBe(row.dark[0]);
    }
  });
});
