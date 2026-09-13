import { env } from 'cloudflare:workers';

/*
 * LiveKit configuration is ambient, so a test that cares must say so.
 *
 * wrangler loads .dev.vars, and a developer who has ever run a call locally
 * has real LIVEKIT_* values in it. That made tests disagree with reality in
 * opposite directions: the "unset" token case asserted 503 and got a token,
 * while the "mints a token" case only ever passed because those secrets
 * happened to be lying around -- it would fail on CI, which has no .dev.vars
 * at all. The mute route's 502 test did the same, and failed CI on main: the
 * unconfigured room there skips the mute and answers 200.
 *
 * Worse, they shared one mutable env object. The fix for the first was to
 * strip the keys, which is a leak waiting to reach the second: one stray
 * interleaving and the token case sees an unconfigured room. That failure was
 * observed once and did not reproduce, which is the signature of exactly this.
 *
 * So neither test reads ambient state now. Each declares the world it needs,
 * and the original values go back afterwards whatever happens -- including
 * the absence of a value, which restores as an absence rather than as
 * undefined sitting where a key used to be.
 */
const LIVEKIT_ENV_KEYS = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;

const LIVEKIT_TEST_ENV: Record<(typeof LIVEKIT_ENV_KEYS)[number], string> = {
  LIVEKIT_URL: 'wss://livekit.invalid',
  LIVEKIT_API_KEY: 'test_api_key',
  LIVEKIT_API_SECRET: 'test_api_secret',
};

export async function withLiveKitConfigured(
  configured: boolean,
  run: () => Promise<void>,
): Promise<void> {
  const mutableEnv = env as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>(
    LIVEKIT_ENV_KEYS.map((key) => [key, mutableEnv[key]]),
  );
  for (const key of LIVEKIT_ENV_KEYS) {
    if (configured) mutableEnv[key] = LIVEKIT_TEST_ENV[key];
    else delete mutableEnv[key];
  }
  try {
    await run();
  } finally {
    for (const key of LIVEKIT_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  }
}
