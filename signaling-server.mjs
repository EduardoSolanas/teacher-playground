import http from 'http';
import { WebSocketServer } from 'ws';

const WS_READY_STATE_CONNECTING = 0;
const WS_READY_STATE_OPEN = 1;
const PING_TIMEOUT_MS = 30_000;
const port = Number(process.env.SIGNALING_PORT || process.env.PORT || 3001);

const topics = new Map();
const wss = new WebSocketServer({ noServer: true });

function send(conn, message) {
  if (conn.readyState !== WS_READY_STATE_CONNECTING && conn.readyState !== WS_READY_STATE_OPEN) {
    conn.close();
    return;
  }

  try {
    conn.send(JSON.stringify(message));
  } catch {
    conn.close();
  }
}

function getTopic(topicName) {
  let topic = topics.get(topicName);
  if (!topic) {
    topic = new Set();
    topics.set(topicName, topic);
  }
  return topic;
}

function removeConnection(conn, subscribedTopics) {
  subscribedTopics.forEach((topicName) => {
    const topic = topics.get(topicName);
    if (!topic) return;
    topic.delete(conn);
    if (topic.size === 0) {
      topics.delete(topicName);
    }
  });
  subscribedTopics.clear();
}

wss.on('connection', (conn) => {
  const subscribedTopics = new Set();
  let closed = false;
  let pongReceived = true;

  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      conn.close();
      clearInterval(pingInterval);
      return;
    }

    pongReceived = false;
    try {
      conn.ping();
    } catch {
      conn.close();
    }
  }, PING_TIMEOUT_MS);

  conn.on('pong', () => {
    pongReceived = true;
  });

  conn.on('close', () => {
    closed = true;
    clearInterval(pingInterval);
    removeConnection(conn, subscribedTopics);
  });

  conn.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (!message?.type || closed) return;

    if (message.type === 'subscribe') {
      for (const topicName of message.topics || []) {
        if (typeof topicName !== 'string') continue;
        getTopic(topicName).add(conn);
        subscribedTopics.add(topicName);
      }
      return;
    }

    if (message.type === 'unsubscribe') {
      for (const topicName of message.topics || []) {
        const topic = topics.get(topicName);
        if (!topic) continue;
        topic.delete(conn);
        subscribedTopics.delete(topicName);
        if (topic.size === 0) {
          topics.delete(topicName);
        }
      }
      return;
    }

    if (message.type === 'publish' && typeof message.topic === 'string') {
      const receivers = topics.get(message.topic);
      if (!receivers) return;

      message.clients = receivers.size;
      receivers.forEach((receiver) => send(receiver, message));
      return;
    }

    if (message.type === 'ping') {
      send(conn, { type: 'pong' });
    }
  });
});

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain' });
  response.end('okay');
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`y-webrtc signaling server running on ws://0.0.0.0:${port}`);
});
