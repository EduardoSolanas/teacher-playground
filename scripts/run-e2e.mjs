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
const signalingPort = process.env.E2E_SIGNALING_PORT || String(await getAvailablePort());
const baseURL = `http://127.0.0.1:${appPort}`;

const child = spawn(
  process.execPath,
  ['node_modules/playwright/cli.js', 'test', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_PORT: appPort,
      E2E_SIGNALING_PORT: signalingPort,
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
