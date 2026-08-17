# Missing features vs Pencil Spaces

Gap analysis of **teacher-playground** against [Pencil Spaces](https://pencilspaces.com/) (virtual classroom + whiteboard platform).

**Snapshot:** teacher-playground is a secure collaborative whiteboard MVP (Excalidraw + Yjs, waiting room, host controls, Cloudflare Access). Pencil is a full virtual classroom + ops platform. Most Pencil product surface is still missing here.

Baseline comparison date: 2026-08-17.

---

## Present or partial in teacher-playground

| Area | Status | Notes |
|------|--------|--------|
| Infinite collaborative whiteboard | Present | Excalidraw + Yjs / WebRTC signaling |
| Presence + remote cursors | Present | Host role, peer list |
| Waiting room | Present | Admit / reject |
| Host moderation | Present | Kick / suspend |
| Sticky notes, undo/redo, shortcuts | Present | |
| Auth | Partial | Cloudflare Access (not Clever / ClassLink / LTI SSO) |
| Board persistence | Partial | Local / room storage — not cloud semester-long Spaces |
| Content library UI | Stub | `LibraryPanel` placeholder only (“Saved whiteboard items will appear here”) |

---

## Missing features (by category)

### 1. Live classroom (A/V + session UX)

- [ ] Video calling
- [ ] Audio calling
- [ ] Screen sharing
- [ ] Pop-out / pin layouts
- [ ] Virtual backgrounds
- [ ] Noise cancellation
- [ ] In-space chat (1:1 + group, persisted)
- [ ] Raise hand
- [ ] Session timer
- [ ] Follow-me / view lock (“lead students”)
- [ ] Idle / tab-switch distraction alerts
- [ ] Connection quality indicators
- [ ] Tech-check / system status
- [ ] Breakout rooms
- [ ] Private per-student boards
- [ ] Board folders
- [ ] Granular per-student edit permissions (beyond host vs peer)

### 2. Teaching content

- [ ] Built-in apps / manipulatives library (math, literacy, dice, etc.)
- [ ] Collaborative browser / embed third-party tools (IXL, Desmos, Kahoot, Nearpod, Quizlet, …)
- [ ] Annotate PDFs / PPT / docs on the board
- [ ] Google Drive / OneDrive import
- [ ] In-board Google Docs edit
- [ ] Math / literacy backgrounds
- [ ] Equation editor
- [ ] Timers (teaching timer tools)
- [ ] Polls
- [ ] Stickers / celebrations
- [ ] Real content library (replace stub `LibraryPanel`)

### 3. Recording and AI

- [ ] Session recording (device and/or cloud)
- [ ] Privacy-aware recording controls
- [ ] Diarized transcripts
- [ ] AI session summaries
- [ ] AI teaching assistant (Pencil “Sparky”-class)
- [ ] AI autograding / learning-gap advice
- [ ] AI Coach / rubric coaching
- [ ] Talk-time analytics
- [ ] Safeguarding alerts (e.g. profanity)

### 4. Scheduling and operations

- [ ] Calendar UI
- [ ] Bulk / recurring scheduling
- [ ] Auto attendance
- [ ] Reminders
- [ ] Calendar sync
- [ ] Admin live session view
- [ ] Org reports + CSV export
- [ ] Student rostering
- [ ] LMS / SIS integrations
- [ ] Multi-site institution management
- [ ] Custom roles / tags
- [ ] Embed iframe
- [ ] Public APIs + webhooks
- [ ] White-label theming
- [ ] Education SSO (Clever, ClassLink, LTI)

### 5. Cloud Spaces model

- [ ] Named persistent Spaces across semesters
- [ ] Cloud board history / restore
- [ ] Multi-board Space organization
- [ ] Cross-device sync of saved library items

---

## Implementation plan: Phase 0 → full (easiest → hardest)

Ordered by implementation difficulty and dependency order. Finish earlier phases before leaning on later ones. Checkboxes match the missing-feature lists above.

### Phase 0 — Foundations (easiest; unblocks everything)

Goal: real persistence + a non-stub library so later classroom features have somewhere to live.

- [ ] Cloud board persistence (replace local/room-only storage)
- [ ] Named persistent Spaces (create / open / list)
- [ ] Cloud board history / restore (basic)
- [ ] Real content library (replace stub `LibraryPanel`) — save / reopen whiteboard items
- [ ] Cross-device sync of saved library items

**Exit:** teacher can leave a Space and reopen the same board on another device.

### Phase 1 — Lightweight classroom UX (easy–medium)

Goal: session feel without A/V yet.

- [ ] In-space chat (group first; then 1:1)
- [ ] Raise hand
- [ ] Session timer
- [ ] Connection quality indicators
- [ ] Tech-check / system status
- [ ] Follow-me / view lock (“lead students”)
- [ ] Idle / tab-switch distraction alerts
- [ ] Granular per-student edit permissions (beyond host vs peer)
- [ ] Timers (teaching timer tools)
- [ ] Polls
- [ ] Stickers / celebrations

**Exit:** host can run an ordered live board session with chat and basic classroom controls.

### Phase 2 — Multi-board session structure (medium)

Goal: Pencil-like Space organization during a lesson.

- [ ] Private per-student boards
- [ ] Board folders
- [ ] Multi-board Space organization
- [ ] Breakout rooms

**Exit:** host can split work across private boards / breakouts and return to the shared board.

### Phase 3 — Live A/V (medium–hard)

Goal: turn the board into a real virtual classroom. Harder ops (media servers, permissions, device UX).

- [ ] Audio calling
- [ ] Video calling
- [ ] Screen sharing
- [ ] Pop-out / pin layouts
- [ ] Noise cancellation
- [ ] Virtual backgrounds

**Exit:** stable host + students A/V with screen share in a Space.

### Phase 4 — Teaching content depth (medium–hard)

Goal: teaching workflow beyond a blank board.

- [ ] Math / literacy backgrounds
- [ ] Equation editor
- [ ] Annotate PDFs / PPT / docs on the board
- [ ] Built-in apps / manipulatives library (math, literacy, dice, etc.)
- [ ] Collaborative browser / embed third-party tools (IXL, Desmos, Kahoot, Nearpod, Quizlet, …)
- [ ] Google Drive / OneDrive import
- [ ] In-board Google Docs edit

**Exit:** common lesson materials can be opened, annotated, and reused from the library.

### Phase 5 — Recording & review (hard)

Goal: async value + evidence for later AI / safeguarding.

- [ ] Session recording (device and/or cloud)
- [ ] Privacy-aware recording controls
- [ ] Diarized transcripts
- [ ] Talk-time analytics

**Exit:** host can record a session and get a usable transcript + talk-time summary.

### Phase 6 — Scheduling & school ops (hard)

Goal: institution adoption beyond a single demo Space.

- [ ] Calendar UI
- [ ] Bulk / recurring scheduling
- [ ] Reminders
- [ ] Calendar sync
- [ ] Auto attendance
- [ ] Student rostering
- [ ] Admin live session view
- [ ] Org reports + CSV export
- [ ] Education SSO (Clever, ClassLink, LTI)
- [ ] LMS / SIS integrations
- [ ] Multi-site institution management
- [ ] Custom roles / tags
- [ ] Embed iframe
- [ ] Public APIs + webhooks
- [ ] White-label theming

**Exit:** a school can schedule recurring Spaces, roster students, and export attendance/reports.

### Phase 7 — AI layer (hardest; depends on Phases 4–5)

Goal: Pencil-class assistive features. Do not start until recording/transcripts and content hooks exist.

- [ ] AI session summaries
- [ ] AI teaching assistant (Pencil “Sparky”-class)
- [ ] AI autograding / learning-gap advice
- [ ] AI Coach / rubric coaching
- [ ] Safeguarding alerts (e.g. profanity)

**Exit:** post-session summary + in-lesson assist that use real board/recording context.

### Difficulty ladder (summary)

| Phase | Difficulty | Depends on | Theme |
|-------|------------|------------|--------|
| **0** | Easiest | Current MVP | Cloud Spaces + real library |
| **1** | Easy–medium | Phase 0 | Chat + host classroom controls |
| **2** | Medium | Phase 0–1 | Private boards / breakouts |
| **3** | Medium–hard | Phase 1 | Audio / video / screen share |
| **4** | Medium–hard | Phase 0 | Content, embeds, annotate |
| **5** | Hard | Phase 3 | Recording + transcripts |
| **6** | Hard | Phase 0–1 | Scheduling, rostering, SSO, admin |
| **7** | Hardest | Phase 4–5 | AI assist / autograde / coach |

### How to execute this plan

1. Work **one phase at a time**; do not skip to AI or SSO early.
2. Inside a phase, ship vertical slices (one checkbox → PR → tick here).
3. Prefer the existing stack (Excalidraw + Yjs + Cloudflare) before adding new platforms.
4. When a phase completes, open the next phase’s tickets from its checklist.

---

## Suggested build order (toward Pencil-class product)

Prioritized product layers — not a commitment to full parity.

| Priority | Layer | Why |
|----------|--------|-----|
| **P0** | A/V + chat | Turns a board into a classroom |
| **P1** | Cloud-persistent Spaces + private boards / breakouts | Session structure teachers expect |
| **P2** | Host classroom controls | Follow-me, finer permissions, distraction cues |
| **P3** | Recording + transcripts | Review, safeguarding, async value |
| **P4** | Scheduling + attendance | Ops / school adoption |
| **P5** | Content library + embeds | Teaching workflow depth |
| **P6** | AI assist / autograde / coach | Differentiation; depends on recording + content |

---

## Out of scope for this doc

- Exact Pencil pricing / SKU mapping
- Legal / compliance certification parity (SOC2, FERPA packaging, etc.) unless productized as features
- Implementation designs — track those in issues / plans once a layer is picked

---

## How to use

1. Follow **Phase 0 → 7** in the implementation plan (easiest → hardest).
2. Or pick the matching **P0–P6** product layer if prioritizing by classroom value instead of difficulty.
3. Slice the chosen phase into tickets; tick items here (or move them to issues) as they ship.
4. Re-diff against Pencil periodically — their surface moves.
