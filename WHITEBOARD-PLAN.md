# Interactive Whiteboard -- Migration Plan

## Overview

Convert the current Teacher Playground (AI-generated iframe builder) into an **interactive whiteboard** platform similar to **Zoom Whiteboard**. Multiple users (2-3+) join a shared room, see an empty whiteboard canvas with draggable cards, and can collaborate in real-time via WebRTC.

### Core Features (Zoom Whiteboard Parity)

1. Infinite canvas with pan and zoom
2. Freehand drawing (pen tool) with color/size options
3. Text tool -- add, move, resize, recolor text blocks
4. Shape tool -- rectangles, circles, lines, arrows
5. Card/Sticky Note tool -- draggable colored notes
6. Eraser tool
7. Undo/Redo
8. Real-time cursor presence (see other users' cursors)
9. User presence indicators (who's in the room)
10. Board export (PNG download)
11. Room-based joining via shareable link

---

## Technical Stack Decisions

| Layer | Decision | Rationale |
|---|---|---|
| Framework | Next.js 14 (keep) | Already set up, App Router |
| UI Library | React 18 (keep) | Already in use |
| Language | TypeScript (keep) | Already in use |
| Canvas Engine | **Konva.js** (`react-konva`) | Production-grade 2D canvas, zoom/pan built-in, shape primitives, great performance |
| Real-time | WebRTC DataChannel (keep + extend) | Already implemented, peer-to-peer |
| Signaling | **Automatic WebSocket** (`@hocuspocus/provider` + HocusPocus OR custom Socket.IO) | Manual copy/paste is terrible UX for a whiteboard. Need automatic room joining. |
| State Sync | CRDT (`yjs` + `y-webrtc`) | Conflict-free replicated data type -- handles concurrent edits without server. Replaces custom state sync. |
| Styling | **Tailwind CSS** (migrate from inline) | Inline styles don't scale for a complex UI. Tailwind is already in PLAN.md as a recommended stack. |
| Storage | **Vercel KV** or **Supabase** (migrate from file-system) | File-system won't work on serverless. Need persistent board state. |
| Testing | Vitest + Playwright (keep) | Already set up |

---

## Phase 0 -- Project Restructure

### 0.1 Dependencies

- [ ] Install `react-konva konva` (canvas rendering)
- [ ] Install `yjs` (CRDT core)
- [ ] Install `y-webrtc` (WebRTC provider for yjs -- reuses existing WebRTC infra)
- [ ] Install `tailwindcss @tailwindcss/postcss` (CSS framework)
- [ ] Install `@radix-ui/*` or `@headlessui/react` (accessible UI primitives) -- optional, can build manually
- [ ] Remove or deprecate `@google/genai` and `openai` (no longer needed -- AI is out of scope)
- [ ] Remove or deprecate `nock` (no longer mocking AI APIs)
- [ ] Update `storage.ts` to use Vercel KV or Supabase instead of file-system

### 0.2 Tailwind Migration

- [ ] Initialize Tailwind config: `npx tailwindcss init -p`
- [ ] Configure `content` paths in `tailwind.config.js`
- [ ] Create `src/app/globals.css` with `@tailwind base; @tailwind components; @tailwind utilities;`
- [ ] Import `globals.css` in `src/app/layout.tsx`
- [ ] Migrate `src/components/ChatPanel.tsx` to Tailwind classes
- [ ] Migrate `src/components/PreviewFrame.tsx` to Tailwind classes
- [ ] Migrate `src/components/DeployButton.tsx` to Tailwind classes
- [ ] Migrate `src/components/PeerPanel.tsx` to Tailwind classes
- [ ] Migrate `src/app/BuilderPage.tsx` to Tailwind classes
- [ ] Migrate `src/app/PlaygroundPage.tsx` to Tailwind classes
- [ ] Remove all inline `style={{}}` objects from migrated components
- [ ] Verify build passes: `npm run build`

### 0.3 Type System Overhaul

- [ ] Create `src/types/whiteboard.ts` with all whiteboard types:
  ```ts
  // Element types on the canvas
  export type ElementType = "pen" | "text" | "rectangle" | "circle" | "line" | "arrow" | "sticky-note";

  // Base for all canvas elements
  export type CanvasElement =
    | PenStroke
    | TextElement
    | RectangleElement
    | CircleElement
    | LineElement
    | ArrowElement
    | StickyNoteElement;

  // Pen: array of points forming a stroke
  export type PenStroke = {
    id: string;
    type: "pen";
    points: { x: number; y: number }[];
    color: string;
    strokeWidth: number;
  };

  // Text: positioned text block
  export type TextElement = {
    id: string;
    type: "text";
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    color: string;
    fontSize: number;
    fontFamily: string;
    bold: boolean;
    italic: boolean;
  };

  // Rectangle
  export type RectangleElement = {
    id: string;
    type: "rectangle";
    x: number;
    y: number;
    width: number;
    height: number;
    fill: string;
    stroke: string;
    strokeWidth: number;
  };

  // Circle
  export type CircleElement = {
    id: string;
    type: "circle";
    x: number;
    y: number;
    width: number;
    height: number;
    fill: string;
    stroke: string;
    strokeWidth: number;
  };

  // Line
  export type LineElement = {
    id: string;
    type: "line";
    points: { x: number; y: number }[];
    stroke: string;
    strokeWidth: number;
  };

  // Arrow (line with arrowhead)
  export type ArrowElement = {
    id: string;
    type: "arrow";
    points: { x: number; y: number }[];
    stroke: string;
    strokeWidth: number;
  };

  // Sticky note (colored draggable note)
  export type StickyNoteElement = {
    id: string;
    type: "sticky-note";
    x: number;
    y: number;
    width: number;
    height: number;
    content: string;
    backgroundColor: string;
    borderColor: string;
    borderRadius: number;
  };

  // Remote user cursor
  export type RemoteCursor = {
    peerId: string;
    userName: string;
    color: string;
    x: number;
    y: number;
  };

  // Tool state
  export type ToolType =
    | "select"
    | "pen"
    | "text"
    | "rectangle"
    | "circle"
    | "line"
    | "arrow"
    | "sticky-note"
    | "eraser";

  // Drawing palette settings
  export type PaletteSettings = {
    tool: ToolType;
    color: string;
    strokeWidth: number;
    fill: string;
  };

  // Canvas viewport (pan + zoom)
  export type Viewport = {
    x: number;
    y: number;
    zoom: number;
  };

  // Undo/redo history entry
  export type HistoryEntry = {
    elements: CanvasElement[];
  };

  // Room state
  export type WhiteboardRoom = {
    roomId: string;
    elements: CanvasElement[];
    viewport: Viewport;
    cursors: RemoteCursor[];
    users: WhiteboardUser[];
  };

  // Connected user
  export type WhiteboardUser = {
    peerId: string;
    userName: string;
    color: string;
    isHost: boolean;
  };
  ```
- [ ] Delete or archive old `src/types/chat.ts` (rename to `chat.ts.bak`)
- [ ] Create `src/types/index.ts` re-exporting all new types
- [ ] Update all imports across the codebase

### 0.4 New Folder Structure

- [ ] Create `src/components/whiteboard/` directory
- [ ] Create `src/lib/whiteboard/` directory
- [ ] Create `src/hooks/` directory for custom React hooks
- [ ] Move existing collaboration libs to `src/lib/collaboration/`

---

## Phase 1 -- Canvas Engine (No Collaboration Yet)

### 1.1 Konva Setup

- [ ] Create `src/lib/whiteboard/konvaStore.ts` -- singleton Konva state manager
- [ ] Create `src/components/whiteboard/WhiteboardCanvas.tsx` -- main Konva canvas wrapper
- [ ] Implement `Stage` component with `width`, `height`, `draggable` functionality
- [ ] Implement zoom via mouse wheel (`wheel` event -> scale stage)
- [ ] Implement pan via middle-mouse drag or space+drag
- [ ] Create `src/hooks/useWhiteboardCanvas.ts` -- hook to access canvas state
- [ ] Write failing test for canvas stage dimensions
- [ ] Write failing test for zoom level changes
- [ ] Write failing test for pan offset changes
- [ ] Implement minimum tests to pass
- [ ] Verify: `npm test` passes

### 1.2 Infinite Canvas

- [ ] Implement canvas background grid pattern (dots or graph paper style)
- [ ] Implement viewport state: `{ x, y, zoom }`
- [ ] Clamp zoom to `[0.1, 5.0]`
- [ ] Implement "fit to content" button (zoom to show all elements)
- [ ] Implement "reset view" button (zoom 1.0, center 0,0)
- [ ] Write test for grid rendering
- [ ] Write test for zoom clamping
- [ ] Write test for fit-to-content calculation

### 1.3 Tool System

- [ ] Create `src/lib/whiteboard/tools.ts` -- tool registry and state
- [ ] Define `ToolType` enum: `select | pen | text | rectangle | circle | line | arrow | sticky-note | eraser`
- [ ] Create `src/components/whiteboard/ToolSidebar.tsx` -- vertical tool bar (left side)
- [ ] Implement tool icon buttons with active state highlighting
- [ ] Implement tool keyboard shortcuts (V=select, P=pen, T=text, R=rectangle, C=circle, L=line, A=arrow, S=sticky-note, E=eraser)
- [ ] Write test for tool switching
- [ ] Write test for keyboard shortcut registration

### 1.4 Color & Size Palette

- [ ] Create `src/components/whiteboard/PaletteBar.tsx` -- horizontal top bar
- [ ] Implement color picker preset palette (10-12 colors)
- [ ] Implement custom color input (`<input type="color">`)
- [ ] Implement stroke width slider (1px - 20px)
- [ ] Implement fill color toggle (for shapes/stickies)
- [ ] Palette updates reflect in tool state immediately
- [ ] Write test for color selection
- [ ] Write test for stroke width change

---

## Phase 2 -- Drawing Tools

### 2.1 Pen Tool

- [ ] Create `src/components/whiteboard/tools/PenTool.tsx`
- [ ] Implement freehand drawing on mouse down/move/up
- [ ] Store pen strokes as array of `{x, y}` points with color and strokeWidth
- [ ] Render strokes using Konva `Line` with `bezier` smoothing
- [ ] Support multi-stroke (multiple separate pen paths)
- [ ] Draw live preview line while dragging
- [ ] Write failing test for pen stroke creation on mouse down
- [ ] Write failing test for pen stroke points accumulation on mouse move
- [ ] Write failing test for pen stroke finalization on mouse up
- [ ] Implement minimum to pass tests
- [ ] Verify pen drawing works interactively

### 2.2 Eraser Tool

- [ ] Create `src/components/whiteboard/tools/EraserTool.tsx`
- [ ] Implement eraser as a radius-based hit-test tool
- [ ] On eraser drag, detect elements under cursor and remove them
- [ ] For pen strokes, remove points under eraser radius (partial erase)
- [ ] Visual eraser cursor (circle outline following mouse)
- [ ] Write failing test for element removal under eraser
- [ ] Write failing test for partial pen stroke erasure

### 2.3 Text Tool

- [ ] Create `src/components/whiteboard/tools/TextTool.tsx`
- [ ] On click, place a text input overlay on the canvas
- [ ] Support multi-line text input
- [ ] On blur or Enter, convert to Konva `Text` node
- [ ] Text properties: color, fontSize, fontFamily, bold, italic
- [ ] Text element is draggable after placement
- [ ] Double-click existing text to re-edit
- [ ] Implement text resize handles (drag corners)
- [ ] Write failing test for text element creation on canvas click
- [ ] Write failing test for text content update
- [ ] Write failing test for text element drag
- [ ] Write failing test for text re-edit on double-click

### 2.4 Shape Tools

#### Rectangle

- [ ] Create `src/components/whiteboard/tools/RectangleTool.tsx`
- [ ] On mouse down, start a rectangle preview (Konva `Rect`)
- [ ] On mouse move, update width/height of preview rectangle
- [ ] On mouse up, finalize rectangle with fill/stroke/strokeWidth
- [ ] Rectangle is selectable and resizable after placement
- [ ] Write failing test for rectangle preview on mouse down
- [ ] Write failing test for rectangle dimension update on mouse move
- [ ] Write failing test for rectangle finalization on mouse up

#### Circle

- [ ] Create `src/components/whiteboard/tools/CircleTool.tsx`
- [ ] Same flow as rectangle but using Konva `Ellipse`
- [ ] Maintain aspect ratio when Shift is held (draw perfect circle)
- [ ] Write failing test for circle preview
- [ ] Write failing test for circle finalization

#### Line

- [ ] Create `src/components/whiteboard/tools/LineTool.tsx`
- [ ] On mouse down, start a line preview
- [ ] On mouse move, update end point of preview line
- [ ] On mouse up, finalize line with stroke/strokeWidth
- [ ] Line is selectable and has resize handles at both ends
- [ ] Write failing test for line preview
- [ ] Write failing test for line finalization

#### Arrow

- [ ] Create `src/components/whiteboard/tools/ArrowTool.tsx`
- [ ] Same as line but with arrowhead marker at end point
- [ ] Use Konva `Arrow` component with `pointerLength` and `pointerWidth`
- [ ] Write failing test for arrow preview
- [ ] Write failing test for arrow finalization

### 2.5 Sticky Note Tool

- [ ] Create `src/components/whiteboard/tools/StickyNoteTool.tsx`
- [ ] On click, place a colored sticky note at cursor position
- [ ] Default colors: yellow, pink, blue, green, orange (Zoom-style)
- [ ] Sticky note is draggable
- [ ] Double-click to edit note content (inline textarea)
- [ ] Resize handles on corners
- [ ] Change color via palette after selection
- [ ] Write failing test for sticky note placement
- [ ] Write failing test for sticky note drag
- [ ] Write failing test for sticky note content edit

---

## Phase 3 -- Element Selection & Manipulation

### 3.1 Selection System

- [ ] Create `src/lib/whiteboard/selection.ts` -- selection state manager
- [ ] Single element selection on click
- [ ] Multi-element selection via click+drag (selection rectangle)
- [ ] Multi-element selection via Ctrl+click (add to selection)
- [ ] Deselect on canvas click (empty area)
- [ ] Visual selection handles (8-point resize handles on selected elements)
- [ ] Write failing test for single element selection
- [ ] Write failing test for multi-element selection rectangle
- [ ] Write failing test for Ctrl+click additive selection

### 3.2 Resize & Rotate

- [ ] Implement resize by dragging handles (corners + edges)
- [ ] Maintain aspect ratio when Shift is held during resize
- [ ] Implement rotate handle (above selection box)
- [ ] Rotation in 15-degree increments when Shift is held
- [ ] Write failing test for element resize
- [ ] Write failing test for element rotation

### 3.3 Move & Group

- [ ] Move selected element(s) by dragging
- [ ] Move multiple selected elements together
- [ ] Group selected elements (Ctrl+G)
- [ ] Ungroup (Ctrl+Shift+G)
- [ ] Group is treated as a single movable unit
- [ ] Write failing test for single element move
- [ ] Write failing test for multi-element group move

### 3.4 Delete & Duplicate

- [ ] Delete selected element(s) with Delete/Backspace key
- [ ] Duplicate selected element(s) with Ctrl+D
- [ ] Duplicate creates element with offset position
- [ ] Write failing test for element deletion
- [ ] Write failing test for element duplication

### 3.5 Bring Forward / Send Backward

- [ ] Bring forward button (Ctrl+])
- [ ] Send backward button (Ctrl+[)
- [ ] Bring to front button (Ctrl+Shift+])
- [ ] Send to back button (Ctrl+Shift+[])
- [ ] Written test for z-index manipulation

---

## Phase 4 -- Undo / Redo

### 4.1 History Manager

- [ ] Create `src/lib/whiteboard/history.ts` -- undo/redo stack manager
- [ ] Push snapshot on every element change (add, edit, delete, move)
- [ ] Limit history to last 50 entries
- [ ] Keyboard shortcuts: Ctrl+Z (undo), Ctrl+Shift+Z / Ctrl+Y (redo)
- [ ] Visual undo/redo buttons in toolbar
- [ ] Disabled state when no undo/redo available
- [ ] Write failing test for history push on element add
- [ ] Write failing test for undo pops last entry
- [ ] Write failing test for redo re-applies undone entry
- [ ] Write failing test for history cap at 50 entries
- [ ] Write failing test for new edit clears future history

---

## Phase 5 -- Real-Time Collaboration (yjs + WebRTC)

### 5.1 yjs Integration

- [ ] Create `src/lib/whiteboard/yjsDoc.ts` -- yjs document setup
- [ ] Initialize `yjs.Doc` instance
- [ ] Create `yjs.Array` for elements (synced across peers)
- [ ] Create `yjs.Map` for viewport state (pan/zoom)
- [ ] Create `yjs.Map` for selection state
- [ ] Define yjs schema for each element type (JSON-serializable)
- [ ] Write failing test for yjs document creation
- [ ] Write failing test for element added to yjs array
- [ ] Write failing test for viewport synced to yjs map

### 5.2 y-webrtc Provider

- [ ] Create `src/lib/whiteboard/ywebrtcProvider.ts` -- WebRTC provider for yjs
- [ ] Initialize `y-webrtc` WebRTC provider with room ID
- [ ] Connect provider to yjs doc
- [ ] Handle provider `synced` event (ready to collaborate)
- [ ] Handle provider `status` events (connecting, connected, disconnected)
- [ ] Write failing test for provider initialization
- [ ] Write failing test for provider synced event

### 5.2 Replace Custom PeerConnectionManager

- [ ] Existing `PeerConnectionManager` was designed for manual signaling -- y-webrtc handles this automatically
- [ ] Create `src/lib/whiteboard/collaboration.ts` -- collaboration layer abstraction
- [ ] Wire yjs doc to `y-webrtc` provider
- [ ] Keep `PeerConnectionManager` as fallback for non-yjs messages (cursors, chat)
- [ ] Write failing test for collaboration layer initialization
- [ ] Write failing test for yjs sync with provider

### 5.3 Bidirectional Sync

- [ ] Local changes -> yjs doc -> y-webrtc -> remote peers
- [ ] Remote changes (yjs `update` event) -> update Konva canvas
- [ ] Create `src/hooks/useYjsSync.ts` -- hook that syncs yjs updates to Konva
- [ ] Debounce yjs-driven canvas updates to avoid render thrashing
- [ ] Write failing test for local change broadcast
- [ ] Write failing test for remote change applied to canvas

---

## Phase 6 -- Room System & Joining

### 6.1 Room Creation

- [ ] Create `src/app/whiteboard/[roomId]/page.tsx` -- whiteboard room page
- [ ] Create `src/app/whiteboard/page.tsx` -- room landing page (create/join)
- [ ] Room ID is a short random string (8 chars, URL-safe)
- [ ] Host creates room -> navigates to `/whiteboard/{roomId}`
- [ ] Guest joins room via same URL
- [ ] First person in room is the "host"
- [ ] Enforce max 3 users per room (y-webrtc + UI check)
- [ ] Write failing test for room creation
- [ ] Write failing test for room join
- [ ] Write failing test for max user enforcement

### 6.2 Shareable Link

- [ ] Create `src/components/whiteboard/SharePanel.tsx`
- [ ] Display shareable URL: `https://app.com/whiteboard/{roomId}`
- [ ] Copy link button
- [ ] QR code for mobile joining (use `qrcode` library)
- [ ] Write failing test for share URL generation
- [ ] Write failing test for copy link to clipboard

### 6.3 User Identity

- [ ] Create `src/components/whiteboard/UserNamePrompt.tsx` -- first-time name entry modal
- [ ] Store name in `localStorage` for returning users
- [ ] Random color assignment per user (persistent per session)
- [ ] Display user name + color badge in top-right corner
- [ ] Write failing test for name prompt display
- [ ] Write failing test for name persistence in localStorage

---

## Phase 7 -- Real-Time Presence & Cursors

### 7.1 Remote Cursors

- [ ] Create `src/components/whiteboard/RemoteCursors.tsx`
- [ ] Broadcast local cursor position via yjs shared map
- [ ] Receive remote cursor positions from yjs
- [ ] Render remote cursors as colored arrow icons with user name labels
- [ | Cursor color matches user's assigned color
- [ ] Cursor follows mouse in real-time (throttled to 30fps)
- [ ] Cursor disappears when user leaves
- [ ] Write failing test for cursor position broadcast
- [ ] Write failing test for remote cursor rendering
- [ ] Write failing test for cursor removal on disconnect

### 7.2 User Presence Panel

- [ ] Create `src/components/whiteboard/PresencePanel.tsx`
- [ ] List connected users with name, color avatar, host badge
- [ ] Show user count: "2/3 users online"
- [ ] Highlight local user
- [ ] Show disconnect indicator when user leaves
- [ ] Write failing test for user list rendering
- [ ] Write failing test for user count display
- [ ] Write failing test for user disconnect handling

### 7.3 Chat (Optional -- keep existing chat or replace)

- [ ] Decide: keep existing chat panel or replace with whiteboard chat
- [ ] If keeping: migrate `ChatPanel` to whiteboard context
- [ ] If replacing: create lightweight whiteboard chat in `PresencePanel`
- [ ] Chat messages broadcast via yjs shared array
- [ ] Write failing test for chat message broadcast
- [ ] Write failing test for chat message receipt

---

## Phase 8 -- UI Polish & UX

### 8.1 Layout

- [ ] Redesign main layout for whiteboard:
  - Left: vertical tool bar (icons)
  - Top: palette bar (color, size, fill)
  - Right: presence panel + share panel (collapsible)
  - Bottom center: undo/redo, zoom controls, fit-to-content
  - Center: infinite canvas
- [ ] Responsive layout for tablet (tools collapse to hamburger)
- [ ] Mobile: canvas only (tools not usable on touch -- or add basic touch support)
- [ ] Write failing test for layout component structure

### 8.2 Context Menu

- [ ] Right-click context menu on canvas elements
- [ ] Options: delete, duplicate, bring forward, send backward, group
- [ ] Right-click on empty canvas: paste, add text, add sticky note
- [ ] Custom context menu (not browser default)
- [ ] Write failing test for context menu open on right-click
- [ ] Write failing test for context menu action execution

### 8.3 Keyboard Shortcuts Bar

- [ ] Create `src/components/whiteboard/ShortcutsHelp.tsx`
- [ ] Press `?` to toggle shortcuts overlay
- [ ] List all keyboard shortcuts
- [ ] Write failing test for shortcuts overlay toggle

### 8.4 Loading States

- [ ] Loading screen while yjs provider connects
- [ ] "Connecting to room..." message
- [ ] Error state if connection fails
- [ ] Write failing test for loading screen display
- [ ] Write failing test for error state display

### 8.5 Empty State

- [ ] Welcome message on empty canvas: "Drag, draw, and collaborate in real-time"
- [ ] Quick-start hint tooltips (first visit)
- [ ] Write failing test for empty state display

---

## Phase 9 -- Export & Persistence

### 9.1 Canvas Export

- [ ] Create `src/lib/whiteboard/export.ts`
- [ ] Export canvas as PNG (current viewport)
- [ ] Export canvas as SVG (vector)
- [ ] Full canvas export (all content, not just viewport)
- [ ] "Download PNG" button in toolbar
- [ ] Configurable export quality and scale (1x, 2x, 4x)
- [ ] Write failing test for PNG export
- [ ] Write failing test for SVG export

### 9.2 Board Persistence

- [ ] Create `src/lib/whiteboard/persistence.ts`
- [ ] Save board state to Vercel KV or Supabase on every change (debounced)
- [ ] Load board state on room entry
- [ ] Save includes: all elements, viewport state
- [ ] Save every 2 seconds (debounced) and on room leave
- [ ] Write failing test for board save
- [ ] Write failing test for board load
- [ ] Write failing test for save on room leave

### 9.3 Room Lifecycle

- [ ] Clean up board state after room inactive for 24 hours
- [ ] Admin (host) can clear the board for all users
- [ ] "Clear Board" confirmation modal
- [ ] Write failing test for board clear
- [ ] Write failing test for stale room cleanup

---

## Phase 10 -- Touch Support

### 10.1 Touch Gestures

- [ ] Single finger pan (drag canvas)
- [ ] Two-finger pinch zoom
- [ ] Two-finger pan (secondary finger drag)
- [ ] Stylus support (pressure-sensitive pen strokes)
- [ ] Write failing test for touch pan
- [ ] Write failing test for pinch zoom
- [ ] Write failing test for stylus pressure input

---

## Phase 11 -- Testing

### 11.1 Unit Tests

- [ ] Test all tool components (Pen, Text, Rectangle, Circle, Line, Arrow, StickyNote, Eraser)
- [ ] Test selection system
- [ ] Test undo/redo history
- [ ] Test yjs document operations
- [ ] Test collaboration layer
- [ ] Test room creation/joining logic
- [ ] Test export functionality
- [ ] Test persistence save/load
- [ ] Test keyboard shortcuts
- [ ] Test palette settings
- [ ] Target: 80%+ code coverage

### 11.2 Integration Tests

- [ ] Test full draw -> sync -> render flow across two simulated peers
- [ ] Test concurrent edits (two users drawing simultaneously)
- [ ] Test undo on local peer doesn't affect remote peer's undo stack
- [ ] Test room join while another user is actively drawing

### 11.3 E2E Tests (Playwright)

- [ ] User creates room -> sees empty whiteboard
- [ ] User draws with pen -> sees stroke on canvas
- [ ] Second user joins same room -> sees existing strokes
- [ ] Second user draws -> first user sees it in real-time
- [ ] User zooms in/out -> both users see same zoom
- [ ] User pans canvas -> both users see same pan
- [ ] User adds text -> second user sees text appear
- [ ] User deletes element -> second user sees it disappear
- [ ] User exports canvas -> PNG file downloads
- [ ] Room enforces max 3 users

---

## Phase 12 -- Performance & Optimization

### 12.1 Canvas Performance

- [ ] Implement viewport culling (only render elements in view)
- [ ] Use Konva `Batching` for bulk updates
- [ ] Debounce resize handler
- [ ] Virtualize large numbers of elements (>500)
- [ ] Profile and fix jank on slow machines
- [ ] Write failing test for viewport culling

### 12.2 Network Performance

- [ ] Compress yjs updates before sending (yjs already does this)
- [ ] Throttle cursor position broadcasts to 30fps
- [ ] Debounce local changes before syncing (50ms)
- [ ] Write failing test for cursor throttle

---

## Phase 13 -- Security

- [ ] Sanitize text content in text elements (prevent XSS)
- [ ] Sanitize sticky note content (prevent XSS)
- [ ] Validate all yjs data before applying (schema validation with Zod)
- [ ] Rate-limit room creation (prevent abuse)
- [ ] Validate room ID format (prevent path traversal)
- [ ] Never expose API keys in client code
- [ ] CSP headers for the app

---

## Phase 14 -- Cleanup & Deprecation

- [ ] Remove AI generation code (`aiProvider.ts`, `generatePlayground.ts`, `normalizeModelHtml.ts`)
- [ ] Remove API routes for AI (`/api/generate-playground`)
- [ ] Remove deploy flow (`DeployButton.tsx`, `/api/playgrounds`)
- [ ] Remove iframe bridge (`iframeBridge.ts`) -- no longer using iframes
- [ ] Remove `PreviewFrame.tsx` component
- [ ] Remove `BuilderPage.tsx` (replaced by whiteboard pages)
- [ ] Archive old `PLAN.md` as `PLAN-v1.md`
- [ ] Update `package.json` scripts
- [ ] Update `.env.local.example`
- [ ] Clean up unused types
- [ ] Remove old tests for deprecated features

---

## Implementation Order Summary

| Phase | Focus | Estimated Effort |
|---|---|---|
| 0 | Project Restructure | 2 days |
| 1 | Canvas Engine (Konva) | 3 days |
| 2 | Drawing Tools | 4 days |
| 3 | Selection & Manipulation | 2 days |
| 4 | Undo / Redo | 1 day |
| 5 | Real-Time Collaboration (yjs) | 3 days |
| 6 | Room System & Joining | 2 days |
| 7 | Presence & Cursors | 2 days |
| 8 | UI Polish & UX | 3 days |
| 9 | Export & Persistence | 2 days |
| 10 | Touch Support | 2 days |
| 11 | Testing | 3 days |
| 12 | Performance | 2 days |
| 13 | Security | 1 day |
| 14 | Cleanup | 1 day |

**Total estimated effort: ~33 developer days**

---

## Migration Notes

### What Stays
- Next.js App Router
- TypeScript
- Vitest + Playwright testing
- WebRTC infrastructure (adapted for y-webrtc)
- Tailwind CSS (newly added)

### What Changes
- **From:** AI-generated HTML in sandboxed iframes
- **To:** Real-time collaborative canvas with Konva + yjs

### What Goes Away
- AI provider integration (Gemini/OpenAI)
- HTML generation and normalization
- Deploy flow and UUID playground URLs
- Iframe bridge
- File-system storage (replaced by Vercel KV / Supabase)

### Key Risks
1. **y-webrtc in browser-only env:** y-webrtc uses WebRTC data channels directly in the browser. This works fine client-side but needs careful handling of room coordination. Consider `y-socket.io` or `y-websocket` if WebRTC-only provider has issues.
2. **Konva + React reconciliation:** Modifying Konva scenes imperatively can conflict with React's virtual DOM. Use `react-konva` consistently and minimize direct Konva API calls from React.
3. **Concurrent edits:** yjs handles this well, but UI conflicts (two users editing same element) need graceful handling. yjs last-write-wins for same-field conflicts; use CRDT arrays for element lists.
4. **Performance with many elements:** A whiteboard can easily have 1000+ elements. Viewport culling and lazy rendering are essential.
5. **Touch + mouse hybrid devices:** Surface-style devices send both touch and mouse events. Need to deduplicate to avoid double-drawing.
