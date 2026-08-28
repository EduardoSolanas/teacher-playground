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
            TEACHER_HOSTNAME: 'example.com',
            GUEST_HOSTNAME: 'join.example.com',
            // Keep unrelated sockets from creating recurring alarms during the
            // worker suite. Tests that exercise revocation set their own
            // deadline; the self-scheduling test configures a short alarm.
            REVOCATION_CHECK_INTERVAL_MS: '3600000',
          },
          r2Buckets: ['BOARD_FILES'],
        },
      };
    }),
  ],
  test: {
    include: ['src/**/*.workers.test.ts'],
    /*
     * These run a real Worker, real Durable Objects and real WebSockets inside
     * workerd, so a single case can legitimately take seconds. On vitest's 5s
     * default the suite passed on a quiet machine and failed on a busy one, in
     * batches, purely on elapsed time — the whole run stretched from ~130s to
     * ~300s and five cases tripped the timeout with nothing wrong.
     *
     * This is a safety net, not an assertion: no test here measures duration,
     * and none of them pass by being slow. Widening a threshold that IS the
     * property under test would be cheating; widening a net that only exists to
     * stop a hung test hanging CI is not.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
