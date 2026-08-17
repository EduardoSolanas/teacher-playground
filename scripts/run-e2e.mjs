import { spawn } from 'node:child_process';
import net from 'node:net';

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to allocate an E2E port'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

const appPort = process.env.E2E_PORT || String(await getAvailablePort());
const baseURL = `http://127.0.0.1:${appPort}`;

// `wrangler dev` serves the static export from ./out, so it has to exist
// before Playwright starts the server. Building here keeps the build out of
// the webServer start timeout.
// NEXT_PUBLIC_E2E is inlined at build time; it re-exposes the debug handles
// that are otherwise stripped from a production bundle.
if (!process.env.E2E_SKIP_BUILD) {
  const build = spawn('npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, NEXT_PUBLIC_E2E: '1' },
  });
  const buildCode = await new Promise((resolve) => build.on('exit', resolve));
  if (buildCode !== 0) {
    process.exit(buildCode ?? 1);
  }
}

const child = spawn(
  process.execPath,
  ['node_modules/playwright/cli.js', 'test', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_PORT: appPort,
      PLAYWRIGHT_BASE_URL: baseURL,
    },
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
