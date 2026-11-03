import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Test only. `vite build` and `vite dev` read vite.config.ts and never see this file.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});
