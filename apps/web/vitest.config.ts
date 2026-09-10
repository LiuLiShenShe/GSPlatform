import path from 'node:path'
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Match apps/web/vite.config.ts so tests resolve the same viewer platform
      // adapter sources as the app.
      '@gsplatform/viewer': path.resolve(__dirname, '../viewer/src/platform'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    testTimeout: 15000,
    hookTimeout: 15000,
    exclude: [
      // Playwright e2e specs use @playwright/test's test() — never run by vitest
      'e2e/**',
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
});
