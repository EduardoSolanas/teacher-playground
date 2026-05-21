const { createServer } = require('http');
const next = require('next');
const { WebSocketServer } = require('ws');

/** Parsed URL shape expected by Next.js `getRequestHandler`. */
function parseUrl(reqUrl, parseQueryString = false) {
  const url = new URL(reqUrl || '/', 'http://internal.local');
  let query = url.search;
  if (parseQueryString) {
    query = {};
    for (const [key, value] of url.searchParams) {
      if (key in query) {
        const existing = query[key];
        query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        query[key] = value;
      }
    }
  }
  const path = url.pathname + url.search;
  return {
    pathname: url.pathname,
    path,
    href: path,
    query,
    search: url.search || null,
    hash: url.hash || null,
  };
}

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev });
const handle = app.getRequestHandler();

// --- y-webrtc signaling (same protocol as y-webrtc/bin/server.js) ---

const wss = new WebSocketServer({ noServer: true });
const topics = new Map();

function send(conn, message) {
  if (conn.readyState > 1) { conn.close(); return; }
  try { conn.send(JSON.stringify(message)); } catch { conn.close(); }
}

wss.on('connection', (conn) => {
  const subs = new Set();
  let closed = false;
  let pong = true;

  const ping = setInterval(() => {
    if (!pong) { conn.close(); clearInterval(ping); return; }
    pong = false;
    try { conn.ping(); } catch { conn.close(); }
  }, 30000);

  conn.on('pong', () => { pong = true; });

  conn.on('close', () => {
    closed = true;
    for (const t of subs) {
      const s = topics.get(t);
      if (s) { s.delete(conn); if (s.size === 0) topics.delete(t); }
    }
    subs.clear();
  });

  conn.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (!msg?.type || closed) return;
    switch (msg.type) {
      case 'subscribe':
        for (const t of msg.topics || []) {
          if (typeof t !== 'string') continue;
          if (!topics.has(t)) topics.set(t, new Set());
          topics.get(t).add(conn);
          subs.add(t);
        }
        break;
      case 'unsubscribe':
        for (const t of msg.topics || []) {
          const s = topics.get(t);
          if (s) s.delete(conn);
        }
        break;
      case 'publish':
        if (msg.topic) {
          const receivers = topics.get(msg.topic);
          if (receivers) {
            msg.clients = receivers.size;
            for (const r of receivers) send(r, msg);
          }
        }
        break;
      case 'ping':
        send(conn, { type: 'pong' });
        break;
    }
  });
});

// --- Start ---

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parseUrl(req.url, true));
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parseUrl(req.url, true);
    if (pathname === '/signaling') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
    // All other upgrade requests (Next.js HMR) fall through naturally
  });

  server.listen(port, () => {
    console.log(`> Next.js + signaling ready on http://localhost:${port}`);
  });
});
