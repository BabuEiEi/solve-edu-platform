import { defineConfig, devices } from '@playwright/test'

// Runs against Vite dev server + Supabase Local (npm run test:e2e resets the local DB first).
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1, // tests share one seeded database
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure', locale: 'th-TH' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
