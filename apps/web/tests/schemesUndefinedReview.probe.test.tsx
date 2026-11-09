// Adversarial review probe: the older useUI mocks across the suite omit scheme and setScheme. Names follow the
// KILLS / CONFIRMS / ACCEPTED convention. Nothing here changes application code.
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GeneralSettings } from '../src/screens/Settings';
import { Router } from './helpers';

vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {}, pushToast: () => {}, setSelectedRecord: () => {} }),
}));

describe('old useUI mocks without scheme', () => {
  it('ACCEPTED: GeneralSettings still renders under a mock with no scheme or setScheme (no radio checked), and the real provider always supplies both so production cannot see undefined', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Router>
          <GeneralSettings />
        </Router>
      </QueryClientProvider>,
    );
    const radios = within(screen.getByRole('radiogroup', { name: 'Color' })).getAllByRole('radio');
    expect(radios).toHaveLength(7);
    for (const radio of radios) expect(radio).not.toBeChecked();
    vi.unstubAllGlobals();
  });
});
