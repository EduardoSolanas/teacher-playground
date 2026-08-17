import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(() => {
      const port = Number(process.env.WORKER_ACCESS_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('WORKER_ACCESS_PORT must be set by the worker test harness');
      }
      const issuer = `http://127.0.0.1:${port}`;
      return {
        wrangler: { configPath: './wrangler.local.toml' },
        miniflare: {
          bindings: {
            ENVIRONMENT: 'local-test',
            ACCESS_ISSUER: issuer,
            ACCESS_AUDIENCE: 'teacher-playground-local',
            ACCESS_JWKS_URL: `${issuer}/jwks`,
            // Short enough for a test to wait for the real alarm rather than
            // triggering it by hand. Production uses the 30s default.
            REVOCATION_CHECK_INTERVAL_MS: '100',
          },
        },
      };
    }),
  ],
  test: {
    include: ['src/**/*.workers.test.ts'],
  },
});
