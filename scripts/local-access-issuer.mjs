#!/usr/bin/env node
/**
 * Ephemeral local Access-like issuer for integration/Playwright runs.
 * Keys are generated at every process start and are never written to disk.
 */
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';

const port = Number(process.env.LOCAL_ACCESS_PORT || 8790);
const issuer = `http://127.0.0.1:${port}`;
const audience = 'teacher-playground-local';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(subject = 'local-human', variant = 'valid', name) {
  const now = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: 'RS256', kid: 'local-key-1' });
  const claims = { iss: issuer, aud: [audience], sub: subject, type: 'app', iat: now, nbf: now, exp: now + 3_600 };
  if (typeof name === 'string' && name.length > 0) claims.name = name;
  if (variant === 'expired') claims.exp = now - 1;
  if (variant === 'wrong-issuer') claims.iss = 'http://evil-access.invalid';
  if (variant === 'wrong-audience') claims.aud = ['wrong-audience'];
  if (variant === 'service-token') claims.type = 'service';
  const payload = encode(claims);
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

const server = createServer((request, response) => {
  response.setHeader('cache-control', 'max-age=30');
  response.setHeader('content-type', 'application/json');
  if (request.url === '/jwks') {
    response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: 'local-key-1', alg: 'RS256', use: 'sig' }] }));
    return;
  }
  if (request.url?.startsWith('/token')) {
    const tokenUrl = new URL(request.url, issuer);
    const subject = tokenUrl.searchParams.get('sub') || 'local-human';
    const variant = tokenUrl.searchParams.get('variant') || 'valid';
    const name = tokenUrl.searchParams.get('name') || '';
    if (variant === 'malformed') {
      response.end(JSON.stringify({ token: 'not-a-jwt' }));
      return;
    }
    response.end(JSON.stringify({ token: token(subject, variant, name) }));
    return;
  }
  if (request.url === '/health') {
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`local Access issuer listening at ${issuer}\n`);
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
