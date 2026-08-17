import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

const BASE = 'https://example.com';

function roomUrl(roomId: string, suffix = ''): string {
  return `${BASE}/api/whiteboard/room/${roomId}${suffix}`;
}

async function createRoom(roomId: string, body: Record<string, unknown> = {}) {
  return SELF.fetch(roomUrl(roomId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [], ...body }),
  });
}

describe('Worker routing into RoomDO', () => {
  it('creates a room and reads it back', async () => {
    const created = await createRoom('alpha', { name: 'Algebra', maxUsers: 4 });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      success: true,
      name: 'Algebra',
      maxUsers: 4,
    });

    const fetched = await SELF.fetch(roomUrl('alpha'));
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({
      room_id: 'alpha',
      name: 'Algebra',
      maxUsers: 4,
      elements: [],
    });
  });

  it('returns 404 for a room that does not exist', async () => {
    const res = await SELF.fetch(roomUrl('nope'));
    expect(res.status).toBe(404);
  });

  it('isolates state between rooms', async () => {
    await createRoom('room-a', { name: 'A' });
    await createRoom('room-b', { name: 'B' });

    const a = await (await SELF.fetch(roomUrl('room-a'))).json();
    const b = await (await SELF.fetch(roomUrl('room-b'))).json();

    expect((a as { name: string }).name).toBe('A');
    expect((b as { name: string }).name).toBe('B');
  });

  it('deletes a room', async () => {
    await createRoom('doomed');
    const del = await SELF.fetch(roomUrl('doomed'), { method: 'DELETE' });
    expect(del.status).toBe(200);

    const after = await SELF.fetch(roomUrl('doomed'));
    expect(after.status).toBe(404);
  });

  it('routes the presence sub-path', async () => {
    await createRoom('present');
    const res = await SELF.fetch(roomUrl('present', '/presence'));
    expect(res.status).toBe(200);
  });

  it('rejects unknown paths', async () => {
    const res = await SELF.fetch(`${BASE}/nothing/here`);
    expect(res.status).toBe(404);
  });
});

describe('y-webrtc signaling over Durable Object WebSockets', () => {
  async function connect(roomId: string): Promise<WebSocket> {
    const res = await SELF.fetch(`${BASE}/signaling?room=${roomId}`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error('no webSocket on response');
    ws.accept();
    return ws;
  }

  function nextMessage(ws: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), 2000);
      ws.addEventListener('message', (event: MessageEvent) => {
        clearTimeout(timer);
        resolve(String(event.data));
      }, { once: true });
    });
  }

  it('requires a room on the signaling URL', async () => {
    const res = await SELF.fetch(`${BASE}/signaling`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-websocket request', async () => {
    const res = await SELF.fetch(`${BASE}/signaling?room=x`);
    expect(res.status).toBe(426);
  });

  it('fans a publish out to the other peer in the same room', async () => {
    const a = await connect('signal-room');
    const b = await connect('signal-room');

    const received = nextMessage(b);
    a.send(JSON.stringify({ type: 'publish', topic: 'whiteboard-signal-room', data: 'hello' }));

    const payload = JSON.parse(await received);
    expect(payload).toMatchObject({
      type: 'publish',
      topic: 'whiteboard-signal-room',
      data: 'hello',
    });
    // y-webrtc uses this to learn how many peers are on the topic.
    expect(payload.clients).toBe(2);
  });

  // server.js sends a publish to every subscriber including the publisher, and
  // y-webrtc relies on that for peer discovery; it de-duplicates by peer id.
  it('echoes a publish back to its sender, as the reference server does', async () => {
    const a = await connect('echo-room');
    await connect('echo-room');

    const own = nextMessage(a);
    a.send(JSON.stringify({ type: 'publish', topic: 't', data: 1 }));

    expect(JSON.parse(await own)).toMatchObject({ type: 'publish', topic: 't', data: 1 });
  });

  it('does not leak a publish across rooms', async () => {
    const a = await connect('room-one');
    const outsider = await connect('room-two');

    let leaked = false;
    outsider.addEventListener('message', () => { leaked = true; }, { once: true });

    a.send(JSON.stringify({ type: 'publish', topic: 't', data: 1 }));
    await new Promise((r) => setTimeout(r, 200));

    expect(leaked).toBe(false);
  });

  it('replies to an application-level ping', async () => {
    const ws = await connect('ping-room');
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    expect(JSON.parse(await reply)).toEqual({ type: 'pong' });
  });
});

describe('static asset serving', () => {
  it('serves the app shell at the root', async () => {
    const res = await SELF.fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves the placeholder room page for an arbitrary room URL', async () => {
    const res = await SELF.fetch(`${BASE}/whiteboard/some-room-id`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves the same page regardless of room id', async () => {
    const a = await (await SELF.fetch(`${BASE}/whiteboard/room-aaa`)).text();
    const b = await (await SELF.fetch(`${BASE}/whiteboard/room-bbb`)).text();
    expect(a).toBe(b);
  });
});
