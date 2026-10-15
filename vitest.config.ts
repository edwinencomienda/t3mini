import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Tests never run the real Tailscale CLI (tailscale.test.ts points this at a fake one).
    env: { TAILSCALE_BIN: '/nonexistent/tailscale' },
  },
})
