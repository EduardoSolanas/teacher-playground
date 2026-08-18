# WebRTC privacy and peer IP exposure

This document records how board synchronization and optional A/V relate to WebRTC,
ICE candidates, and peer IP visibility. It is policy only — no runtime behavior
changes in this slice.

## Whiteboard sync (no P2P WebRTC)

Yjs board synchronization uses **y-websocket** over the authenticated Cloudflare
Worker **`/signaling`** WebSocket upgrade (routed to `RoomDO`). Peers do **not**
exchange document updates through **y-webrtc** or direct browser-to-browser data
channels for the board.

- Client entry: `SignalingWebsocketProvider` in [`src/lib/whiteboard/yWebsocketProvider.ts`](src/lib/whiteboard/yWebsocketProvider.ts).
- Worker route: `GET /signaling?room=…` in [`src/worker.ts`](src/worker.ts).

Because sync is server-relayed over TLS WebSockets, participants do not learn
each other's host or srflx ICE candidates from the whiteboard path.

## LiveKit A/V (WebRTC to SFU)

Optional audio/video uses **LiveKit** (WebRTC to an SFU), not y-webrtc. Depending
on LiveKit server settings and whether TURN is configured, browsers may still
gather and exchange **host**, **srflx**, or **relay** ICE candidates with the
SFU and, indirectly, with other participants in the same room.

## When peer IP privacy is required

If hiding participant public or local IP addresses is a requirement:

1. Deploy **managed TURN** (or LiveKit's bundled TURN) with credentials issued
   only to admitted room members.
2. Configure clients and/or the SFU for **relay-only ICE** (`iceTransportPolicy:
   'relay'` or equivalent) so media never uses host/srflx candidates.
3. Operate TURN outside this repository's deploy artifacts — the **current local
   tree does not ship TURN credentials** or a TURN server.

Board sync over `/signaling` already avoids P2P WebRTC; relay-only policy applies
primarily to the LiveKit A/V path.

## LiveKit token path

Short-lived join tokens are minted on the Worker after room admission checks:

- [`src/lib/av/livekitToken.ts`](src/lib/av/livekitToken.ts) — HS256 JWT construction and `LIVEKIT_*` env parsing.
- [`src/lib/av/handleAvToken.ts`](src/lib/av/handleAvToken.ts) — `POST /api/av/token` eligibility (granted roles; waiting peers refused).
- [`src/lib/av/livekitRoomService.ts`](src/lib/av/livekitRoomService.ts) — optional LiveKit room API helpers.

TURN URLs and credentials, when used, are configured in LiveKit/project infra —
not in these modules today.

## References

- [`security.md`](security.md) — y-websocket migration and A/V gates
- [`DEPLOY.md`](DEPLOY.md) — production Worker deployment
