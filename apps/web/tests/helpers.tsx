import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

// Opts in to the router's next major behavior so the test output stays free of upgrade warnings.
export function Router({ children, initialEntries }: { children: ReactNode; initialEntries?: string[] }) {
  return (
    <MemoryRouter initialEntries={initialEntries} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      {children}
    </MemoryRouter>
  );
}
