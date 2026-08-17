/**
 * Local-only Access edge for browser integration tests.
 *
 * Chromium does not attach Playwright extraHTTPHeaders to WebSocket upgrades.
 * This loopback proxy models the edge instead: it extracts the real signed
 * token from CF_Authorization and injects the assertion header for both HTTP
 * and WebSocket traffic. It has no production configuration or bypass path.
 */
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_COOKIE_HEADER_BYTES = 16_384;
const MAX_ACCESS_TOKEN_BYTES = 16_384;

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid loopback port');
  return port;
}

function accessTokenFromCookie(header) {
  if (
    typeof header !== 'string'
    || header.length === 0
    || Buffer.byteLength(header, 'utf8') > MAX_COOKIE_HEADER_BYTES
  ) return undefined;
  const values = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== 'CF_Authorization') continue;
    const value = part.slice(separator + 1).trim();
    if (
      value.length === 0
      || Buffer.byteLength(value, 'utf8') > MAX_ACCESS_TOKEN_BYTES
      || /[\r\n]/.test(value)
    ) return undefined;
    values.push(value);
  }
  return values.length === 1 ? values[0] : undefined;
}

function forwardedHeaders(request, token) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.toLowerCase() === 'cf-access-jwt-assertion') continue;
    headers[name] = value;
  }
  if (token) headers['Cf-Access-Jwt-Assertion'] = token;
  return headers;
}

function forwardedRawHeaders(request, token) {
  const lines = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name.toLowerCase() === 'cf-access-jwt-assertion') continue;
    lines.push(`${name}: ${value}`);
  }
  if (token) lines.push(`Cf-Access-Jwt-Assertion: ${token}`);
  return lines;
}

export function createAccessProxy({ proxyPort, upstreamPort }) {
  const listenPort = validPort(proxyPort);
  const targetPort = validPort(upstreamPort);
  const activeSockets = new Set();
  const server = createHttpServer({ maxHeaderSize: MAX_COOKIE_HEADER_BYTES * 2 }, (request, response) => {
    const token = accessTokenFromCookie(request.headers.cookie);
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: targetPort,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request, token),
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    activeSockets.add(upstream);
    upstream.once('close', () => activeSockets.delete(upstream));
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"error":"proxy unavailable"}');
    });
    request.pipe(upstream);
  });

  server.on('upgrade', (request, clientSocket, head) => {
    const token = accessTokenFromCookie(request.headers.cookie);
    const upstreamSocket = net.connect(targetPort, '127.0.0.1');
    activeSockets.add(upstreamSocket);
    activeSockets.add(clientSocket);
    const requestHead = [
      `${request.method} ${request.url} HTTP/1.1`,
      ...forwardedRawHeaders(request, token),
      '',
      '',
    ].join('\r\n');
    upstreamSocket.once('connect', () => {
      upstreamSocket.write(requestHead);
      if (head.length > 0) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    const closePair = () => {
      activeSockets.delete(upstreamSocket);
      activeSockets.delete(clientSocket);
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
    };
    upstreamSocket.once('error', closePair);
    clientSocket.once('error', closePair);
    upstreamSocket.once('close', () => activeSockets.delete(upstreamSocket));
    clientSocket.once('close', () => activeSockets.delete(clientSocket));
  });

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, '127.0.0.1', resolve);
      });
    },
    async close() {
      for (const socket of activeSockets) socket.destroy();
      if (!server.listening) return;
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const proxy = createAccessProxy({
    proxyPort: process.env.LOCAL_ACCESS_PROXY_PORT,
    upstreamPort: process.env.LOCAL_ACCESS_UPSTREAM_PORT,
  });
  await proxy.listen();
  process.stdout.write(`local Access proxy listening on 127.0.0.1:${process.env.LOCAL_ACCESS_PROXY_PORT}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await proxy.close();
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`local Access proxy shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
