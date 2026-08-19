#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const exportedIndex = resolve(root, 'out/index.html');
const exportedWhiteboard = resolve(root, 'out/whiteboard.html');
if (!existsSync(exportedIndex) || !existsSync(exportedWhiteboard)) {
  console.error(
    'Worker tests serve HTML from ./out. Run `npm run build` first so ASSETS is not empty.',
  );
  process.exit(1);
}

const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => {
      if (error) return reject(error);
      if (!address || typeof address === 'string') return reject(new Error('no loopback port'));
      resolvePort(address.port);
    });
  });
});
const issuer = spawn(process.execPath, [resolve(root, 'scripts/local-access-issuer.mjs')], {
  cwd: root,
  env: { ...process.env, LOCAL_ACCESS_PORT: String(port) },
  stdio: 'ignore',
});

async function waitForIssuer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (issuer.exitCode !== null) throw new Error(`local Access issuer exited with ${issuer.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The child is still binding its loopback socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('local Access issuer did not start');
}

let exitCode = 1;
try {
  await waitForIssuer();
  const vitest = spawn(
    process.execPath,
    [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.workers.config.mts', ...process.argv.slice(2)],
    { cwd: root, env: { ...process.env, WORKER_ACCESS_PORT: String(port) }, stdio: 'inherit' },
  );
  exitCode = await new Promise((resolve) => vitest.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1))));
} finally {
  if (issuer.exitCode === null) issuer.kill('SIGTERM');
  await new Promise((resolve) => {
    if (issuer.exitCode !== null) return resolve();
    issuer.once('exit', () => resolve());
  });
}
process.exitCode = exitCode;
