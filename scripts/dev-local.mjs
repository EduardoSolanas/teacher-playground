#!/usr/bin/env node
/**
 * One-command local stack: Access issuer + Worker + Access proxy, wired to
 * localhost hostnames.
 *
 * The three surfaces the Worker serves are decided by Host header, so local
 * development needs three names, not three ports. Chrome resolves any
 * `*.localhost` label to loopback with no hosts-file entry, so the hostnames
 * below work as-is on a clean machine.
 *
 * Every hostname and port is a variable here — nothing production-specific is
 * hardcoded, and `wrangler.local.toml` is used rather than `wrangler.toml` so a
 * local run can never pick up the deployed hostnames.
 *
 *   npm run dev:local              # build once, then serve
 *   npm run dev:local -- --skip-build
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());

/** Hostnames the Worker matches on. Override with env to test other names. */
const TEACHER_HOSTNAME = process.env.DEV_TEACHER_HOSTNAME ?? 'app.localhost';
const GUEST_HOSTNAME = process.env.DEV_GUEST_HOSTNAME ?? 'join.localhost';
const MARKETING_HOSTNAME = process.env.DEV_MARKETING_HOSTNAME ?? 'www.localhost';

const skipBuild = process.argv.includes('--skip-build') || Boolean(process.env.DEV_SKIP_BUILD);

async function freePort() {
  return new Promise((ok, err) => {
    const server = createServer();
    server.once('error', err);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((e) => (e ? err(e) : ok(port)));
    });
  });
}

function run(command, args, options = {}) {
  return spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
}

async function waitFor(url, label, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {
      // still binding
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not come up at ${url}`);
}

const children = [];
function shutdown(code = 0) {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (!skipBuild) {
  console.log('\nBuilding static assets (npm run build)…');
  const build = run(process.execPath, [resolve(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack']);
  const code = await new Promise((r) => build.once('exit', r));
  if (code !== 0) {
    console.error('\nBuild failed. Fix the build, or re-run with --skip-build to serve the previous one.');
    process.exit(code ?? 1);
  }
} else if (!existsSync(resolve(root, 'out/index.html'))) {
  console.error('\n--skip-build was passed but ./out is empty. Run without it once.');
  process.exit(1);
}

const issuerPort = await freePort();
const workerPort = await freePort();
const proxyPort = await freePort();
const issuerUrl = `http://127.0.0.1:${issuerPort}`;

children.push(run(process.execPath, [resolve(root, 'scripts/local-access-issuer.mjs')], {
  env: { ...process.env, LOCAL_ACCESS_PORT: String(issuerPort) },
  stdio: 'ignore',
}));
await waitFor(`${issuerUrl}/health`, 'Access issuer');

children.push(run(process.execPath, [
  resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
  'dev',
  '--config', 'wrangler.local.toml',
  '--var', 'ENVIRONMENT:local-test',
  '--var', `ACCESS_ISSUER:${issuerUrl}`,
  '--var', 'ACCESS_AUDIENCE:teacher-playground-local',
  '--var', `ACCESS_JWKS_URL:${issuerUrl}/jwks`,
  '--var', `TEACHER_HOSTNAME:${TEACHER_HOSTNAME}`,
  '--var', `GUEST_HOSTNAME:${GUEST_HOSTNAME}`,
  '--var', `MARKETING_HOSTNAME:${MARKETING_HOSTNAME}`,
  '--ip', '127.0.0.1',
  '--port', String(workerPort),
]));
await waitFor(`http://127.0.0.1:${workerPort}/`, 'Worker');

children.push(run(process.execPath, [resolve(root, 'scripts/local-access-proxy.mjs')], {
  env: {
    ...process.env,
    LOCAL_ACCESS_PROXY_PORT: String(proxyPort),
    LOCAL_ACCESS_UPSTREAM_PORT: String(workerPort),
  },
  stdio: 'ignore',
}));
await waitFor(`http://127.0.0.1:${proxyPort}/`, 'Access proxy');

const { token } = await fetch(`${issuerUrl}/token?sub=local-teacher`).then((r) => r.json());

const teacherOrigin = `http://${TEACHER_HOSTNAME}:${proxyPort}`;
const guestOrigin = `http://${GUEST_HOSTNAME}:${workerPort}`;
const marketingOrigin = `http://${MARKETING_HOSTNAME}:${workerPort}`;

console.log(`
────────────────────────────────────────────────────────────────────
  Local stack is up.

  TEACHER    ${teacherOrigin}/whiteboard
             (behind the local Access proxy — needs the cookie below)

  STUDENT    ${guestOrigin}/whiteboard/<roomId>
             (no Access, exactly like production's guest hostname)

  LANDING    ${marketingOrigin}/

  The teacher origin stands in for Cloudflare Access. Open it, then paste
  this ONCE into the DevTools console to authenticate, and reload:

document.cookie='CF_Authorization=${token}; path=/'; location.reload()

  Ctrl+C stops all three.
────────────────────────────────────────────────────────────────────
`);

for (const child of children) {
  child.once('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\nA local service exited with ${code}. Shutting the rest down.`);
      shutdown(code ?? 1);
    }
  });
}
