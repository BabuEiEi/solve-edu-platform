import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { sourcemap: true },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js', 'tests/functions/**/*.test.js'],
    // A hang guard, not a speed check: view tests take <0.5 s idle but exceeded
    // the 5 s default when the CPU was busy (e.g. right after `db reset`).
    testTimeout: 20_000,
  },
})
