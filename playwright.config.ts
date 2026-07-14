import { defineConfig, devices } from '@playwright/test'

// E2E tests land at Epic 8 (per docs/build/mvp-lite-epic.md §Constraints).
// This config exists so `npm run test:e2e` doesn't error in Epic 1; tests/e2e/
// is empty for now.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3450',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
