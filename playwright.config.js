import { defineConfig, devices } from '@playwright/test'

// Runs against Vite dev server + Supabase Local (npm run test:e2e resets the local DB first).
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1, // tests share one seeded database
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure', locale: 'th-TH' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Safari's engine on an iPhone (2C.1). Run on its own, after a reset (npm run test:e2e:webkit):
    // projects share one database. WebKit is slower here, so it waits longer before failing.
    {
      name: 'webkit-iphone',
      use: { ...devices['iPhone 15'] },
      timeout: 60_000,
      expect: { timeout: 15_000 },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
