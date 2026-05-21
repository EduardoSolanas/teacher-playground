# Teacher Playground Plan

## Product Goal

Build a Next.js app where a user chats with an AI assistant to generate an interactive educational playground. The generated playground is rendered live in a sandboxed iframe. When the user is happy, they can deploy it to a UUID URL. Two or three peers can open the playground and connect with WebRTC peer-to-peer data channels.

## Technical Decisions

- [x] Use Next.js App Router.
- [x] Use TypeScript.
- [x] Use server-side API routes for OpenAI calls so the API key is never exposed in the browser.
- [x] Render generated HTML in a sandboxed iframe, not a canvas.
- [x] Store deployed playgrounds by UUID.
- [x] Use WebRTC `RTCDataChannel` for peer-to-peer communication.
- [x] Use a small backend or realtime service only for signaling if automatic peer joining is required.
- [x] Keep actual peer collaboration traffic peer-to-peer after connection setup.

## Recommended Stack

- [x] Next.js
- [x] React
- [x] TypeScript
- [x] Tailwind CSS
- [x] OpenAI SDK
- [x] Zod
- [x] UUID
- [x] Vitest
- [x] Testing Library
- [x] Playwright
- [x] Vercel KV, Supabase, or Postgres for playground storage

## Project Setup

- [x] Create a new Next.js app with TypeScript.
- [x] Enable App Router.
- [x] Install required dependencies.
- [x] Configure ESLint.
- [x] Configure Vitest.
- [x] Configure Testing Library.
- [x] Configure Playwright.
- [x] Add `.env.local.example`.
- [x] Document required environment variables.

## Environment Variables

- [x] Add `OPENAI_API_KEY`.
- [x] Add `OPENAI_MODEL`.
- [x] Add storage provider variables.
- [x] Add optional signaling provider variables.
- [x] Ensure `.env.local` is gitignored.
- [x] Ensure no frontend code references `OPENAI_API_KEY`.

Example:

```txt
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
PLAYGROUND_STORAGE_PROVIDER=
DATABASE_URL=
```

## App Routes

- [x] Create `/` as the builder page.
- [x] Create `/playground/[uuid]` as the deployed playground page.
- [x] Create `/api/generate-playground`.
- [x] Create `/api/playgrounds`.
- [x] Create `/api/playgrounds/[uuid]`.
- [x] Optionally create `/api/signaling` or integrate an external realtime signaling service.

## Core Types

- [x] Create `ChatMessage` type.
- [x] Create `PlaygroundDocument` type.
- [x] Create `GeneratePlaygroundRequest` type.
- [x] Create `GeneratePlaygroundResponse` type.
- [x] Create `PeerMessage` type.
- [x] Create `ConnectedPeer` type.

Suggested types:

```ts
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type PlaygroundDocument = {
  uuid: string;
  html: string;
  createdAt: string;
  updatedAt: string;
};

export type GeneratePlaygroundRequest = {
  messages: ChatMessage[];
  currentHtml?: string;
};

export type GeneratePlaygroundResponse = {
  html: string;
};

export type PeerMessage = {
  type: "cursor" | "state" | "event" | "chat";
  payload: unknown;
};
```

## Layout

- [x] Build a two-column desktop layout.
- [x] Put the chat panel on the left.
- [x] Put the playground preview on the right.
- [x] Make the layout responsive.
- [x] On mobile, stack chat above preview.
- [x] Keep the chat input accessible on small screens.
- [x] Add a deploy button near the chat controls.
- [x] Add loading states.
- [x] Add error states.

## Builder Page

- [x] Render the chat panel.
- [x] Render the preview iframe.
- [x] Render the deploy button.
- [x] Store chat messages in state.
- [x] Store generated HTML in state.
- [x] Store generation loading state.
- [x] Store generation error state.
- [x] Send user prompt to `/api/generate-playground`.
- [x] Pass existing generated HTML as `currentHtml` for refinement.
- [x] Update iframe when new HTML is returned.
- [x] Add assistant message after successful generation.
- [x] Show an error if generation fails.

## Chat Panel

- [x] Show existing messages.
- [x] Add textarea for user prompt.
- [x] Add send button.
- [x] Disable send button when input is empty.
- [x] Disable send button while generating.
- [x] Submit on button click.
- [x] Optionally submit on `Ctrl+Enter`.
- [x] Clear input after successful submit.
- [x] Show generation errors.

## Preview Frame

- [x] Render generated HTML using iframe `srcDoc`.
- [x] Add `title="Playground preview"`.
- [x] Add iframe sandboxing.
- [x] Do not use `allow-same-origin` unless absolutely required.
- [x] Use `allow-scripts` so generated playgrounds can be interactive.
- [x] Use a default placeholder HTML document before generation.

Recommended iframe:

```tsx
<iframe
  title="Playground preview"
  sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
  srcDoc={html}
/>
```

## OpenAI Generate API

- [x] Implement `POST /api/generate-playground`.
- [x] Validate request body with Zod.
- [x] Reject invalid requests with `400`.
- [x] Read `OPENAI_API_KEY` server-side only.
- [x] Send conversation context to OpenAI.
- [x] Include current HTML when refining an existing playground.
- [x] Use a strict system prompt.
- [x] Require the model to return only complete HTML.
- [x] Strip accidental Markdown code fences.
- [x] Validate response looks like HTML.
- [x] Return `{ html }`.
- [x] Return `502` if the model returns invalid output.
- [x] Add request size limits.
- [x] Add basic rate limiting.

System prompt:

```txt
You generate complete, self-contained educational HTML playgrounds.

Return only a complete HTML document.
No Markdown.
No explanations.
No code fences.

Requirements:
- Include <!doctype html>, html, head, and body.
- Inline all CSS and JavaScript.
- Do not load external scripts.
- Do not call external APIs.
- Make the UI interactive.
- Make it appropriate for the user's requested educational playground.
- Keep the document safe to run inside a sandboxed iframe.
- Include a small postMessage bridge for parent-page collaboration events.
```

## HTML Normalization

- [x] Create `normalizeModelHtml`.
- [x] Remove Markdown fences.
- [x] Trim whitespace.
- [x] Keep valid full HTML unchanged.
- [x] Wrap partial HTML in a full document.
- [x] Remove external script tags.
- [x] Optionally remove external stylesheet links.
- [x] Ensure the result is safe for iframe `srcDoc`.

## Deploy Flow

- [x] Add deploy button.
- [x] Disable deploy while no generated HTML exists.
- [x] On click, call `POST /api/playgrounds`.
- [x] Generate a UUID server-side.
- [x] Store the generated HTML.
- [x] Return the UUID.
- [x] Show the deployed URL.
- [x] Add a copy URL button.
- [x] Add deploy loading state.
- [x] Add deploy error state.

## Playground Storage

- [x] Choose storage provider.
- [x] Create playground storage adapter.
- [x] Implement `createPlayground`.
- [x] Implement `getPlaygroundByUuid`.
- [x] Validate UUID input.
- [x] Reject empty HTML.
- [x] Add max HTML size.
- [x] Store `uuid`.
- [x] Store `html`.
- [x] Store `createdAt`.
- [x] Store `updatedAt`.

Storage record:

```ts
type StoredPlayground = {
  uuid: string;
  html: string;
  createdAt: string;
  updatedAt: string;
};
```

## Playground API

### `POST /api/playgrounds`

- [x] Validate body.
- [x] Generate UUID.
- [x] Save HTML.
- [x] Return `{ uuid }`.
- [x] Return `400` for invalid body.
- [x] Return `500` for storage failure.

### `GET /api/playgrounds/[uuid]`

- [x] Validate UUID.
- [x] Fetch playground.
- [x] Return `{ uuid, html }`.
- [x] Return `404` if missing.
- [x] Return `400` for invalid UUID.

## Playground Runtime Page

- [x] Read UUID from route params.
- [x] Fetch playground HTML.
- [x] Show loading state.
- [x] Show not-found state.
- [x] Render playground in sandboxed iframe.
- [x] Render peer connection panel.
- [x] Show connected peer count.
- [x] Allow host to create a peer room.
- [x] Allow guest to join a peer room.
- [x] Send peer messages into the iframe via `postMessage`.
- [x] Receive iframe messages and broadcast to peers.

## WebRTC Peer Connection

- [x] Create `peerConnection.ts`.
- [x] Implement offer creation.
- [x] Implement answer creation.
- [x] Implement answer acceptance.
- [x] Implement ICE candidate handling.
- [x] Create data channel.
- [x] Send JSON messages over data channel.
- [x] Receive JSON messages from data channel.
- [x] Close connections cleanly.
- [x] Track connection status.
- [x] Handle failed connections.
- [x] Limit peers to 3 total users.

Manual signaling API:

```ts
export type PeerConnectionController = {
  createOffer: () => Promise<string>;
  acceptOffer: (offer: string) => Promise<string>;
  acceptAnswer: (answer: string) => Promise<void>;
  send: (message: PeerMessage) => void;
  close: () => void;
};
```

## Signaling Decision

Choose one:

- [x] Manual copy/paste signaling.
- [x] Automatic signaling with a small WebSocket/realtime backend.

Manual signaling:

- [x] Host clicks â€œCreate roomâ€.
- [x] Host copies generated offer.
- [x] Guest pastes offer.
- [x] Guest copies generated answer.
- [x] Host pastes answer.
- [x] WebRTC connection opens.
- [x] No server is needed for peer setup.

Automatic signaling:

- [x] Host opens playground URL.
- [x] Guest opens same playground URL.
- [x] Both join signaling room by UUID.
- [x] Server exchanges offer, answer, and ICE candidates.
- [x] Data channel opens.
- [x] Collaboration traffic goes peer-to-peer.
- [x] Signaling server is only used for connection setup.

Recommended:

- [x] Use automatic signaling if user experience matters.
- [x] Use manual signaling only if â€œno server for connection setupâ€ is strict.

## Multi-Peer Model

- [x] Use host-centered star topology.
- [x] Host connects to guest 1.
- [x] Host connects to guest 2.
- [x] Guests do not connect directly to each other.
- [x] Host relays guest messages to other guests.
- [x] Enforce max 3 total users.
- [x] Ignore messages from disconnected peers.
- [x] Show peer connection status in UI.

## Iframe Collaboration Bridge

- [x] Parent listens for iframe `postMessage`.
- [x] Parent validates message source shape.
- [x] Parent ignores unrelated messages.
- [x] Parent broadcasts valid playground events to peers.
- [x] Parent receives peer messages.
- [x] Parent sends peer messages into iframe.
- [x] Generated playground includes bridge JavaScript.
- [x] Generated playground can apply remote events.

Parent to iframe:

```ts
iframe.contentWindow?.postMessage(
  {
    source: "teacher-playground",
    type: "peer-message",
    payload
  },
  "*"
);
```

Iframe to parent:

```js
window.parent.postMessage({
  source: "generated-playground",
  type: "playground-event",
  payload: {}
}, "*");
```

## Security

- [x] Never expose OpenAI API key to the browser.
- [x] Sandbox generated HTML.
- [x] Avoid `allow-same-origin` on iframe.
- [x] Block external scripts in generated HTML.
- [x] Limit generation request body size.
- [x] Limit stored HTML size.
- [x] Validate all API request bodies.
- [x] Validate UUID route params.
- [x] Add rate limiting to OpenAI endpoint.
- [x] Do not trust generated iframe messages blindly.
- [x] Only accept known message shapes from iframe.
- [x] Avoid rendering model output directly into the React DOM.
- [x] Use iframe `srcDoc`, not `dangerouslySetInnerHTML`.

## Testing Strategy

Use strict TDD:

- [x] Write a failing test first.
- [x] Confirm it fails.
- [x] Implement the smallest change.
- [x] Confirm it passes.
- [x] Refactor only after tests pass.

## Unit Tests

- [x] Test chat panel renders.
- [x] Test empty chat input disables send.
- [x] Test typing enables send.
- [x] Test submit calls callback.
- [x] Test loading state disables send.
- [x] Test preview iframe uses `srcDoc`.
- [x] Test preview iframe has sandbox attribute.
- [x] Test HTML normalization removes code fences.
- [x] Test HTML normalization wraps partial HTML.
- [x] Test HTML normalization removes external scripts.
- [x] Test deploy button disabled state.
- [x] Test deploy button success state.
- [x] Test deploy button error state.
- [x] Test peer message serialization.
- [x] Test peer manager enforces max peer count.
- [x] Test iframe bridge ignores invalid messages.

## API Tests

- [x] Test generate API rejects invalid body.
- [x] Test generate API calls OpenAI for valid body.
- [x] Test generate API returns normalized HTML.
- [x] Test generate API handles invalid model output.
- [x] Test playground POST rejects empty HTML.
- [x] Test playground POST creates UUID.
- [x] Test playground GET returns stored HTML.
- [x] Test playground GET returns 404 for missing UUID.
- [x] Test playground GET rejects invalid UUID.

## E2E Tests

- [x] User opens builder page.
- [x] User sees chat panel and preview.
- [x] User enters playground request.
- [x] Mock OpenAI endpoint returns HTML.
- [x] Preview updates.
- [x] User clicks deploy.
- [x] Mock deploy endpoint returns UUID.
- [x] User sees deployed URL.
- [x] User opens deployed URL.
- [x] Playground renders from UUID.
- [x] Peer panel appears on playground page.

## Implementation Order

- [x] Initialize Next.js project.
- [x] Add testing setup.
- [x] Create base layout.
- [x] Write failing layout test.
- [x] Implement builder page shell.
- [x] Create chat panel tests.
- [x] Implement chat panel.
- [x] Create preview frame tests.
- [x] Implement preview frame.
- [x] Create HTML normalization tests.
- [x] Implement HTML normalization.
- [x] Create generate API tests.
- [x] Implement generate API.
- [x] Connect builder page to generate API.
- [x] Create deploy button tests.
- [x] Implement deploy button.
- [x] Create storage API tests.
- [x] Implement storage adapter.
- [x] Implement playground POST API.
- [x] Implement playground GET API.
- [x] Create playground route tests.
- [x] Implement playground runtime page.
- [x] Create iframe bridge tests.
- [x] Implement iframe bridge.
- [x] Create WebRTC helper tests.
- [x] Implement WebRTC helper.
- [x] Build peer panel UI.
- [x] Add manual signaling.
- [x] Optionally add automatic signaling.
- [x] Add Playwright happy-path test.
- [x] Run full test suite.
- [x] Run production build.
- [x] Deploy to Vercel.
- [x] Configure production environment variables.
- [x] Verify production behavior.

## Acceptance Criteria

- [x] User can describe a playground in chat.
- [x] App sends prompt to a backend OpenAI endpoint.
- [x] OpenAI API key is never exposed to the client.
- [x] Model returns complete HTML.
- [x] Generated HTML renders in sandboxed iframe.
- [x] User can refine the playground through chat.
- [x] User can deploy the playground.
- [x] Deploy creates a UUID URL.
- [x] Opening UUID URL loads the playground.
- [x] Two peers can connect with WebRTC.
- [x] Three total users are supported.
- [x] Peer messages do not go through the app server after WebRTC connects.
- [x] Generated playground can send events to parent page.
- [x] Parent page can send peer events into generated playground.
- [x] Main flows are covered by tests.
- [x] Production build passes.

## Open Questions

- [x] Should peer joining be manual with copy/paste WebRTC offers, or automatic by UUID?
- [x] Which storage provider should be used: Vercel KV, Supabase, Postgres, or another option?
- [x] Should deployed playgrounds be public forever, expire after a time, or be deletable?
- [x] Should users need authentication before deploying?
- [x] Should playground collaboration sync full state or only lightweight events?
