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

1. Pick the next **P0–P6** layer.
2. Slice into tickets from the checklists above.
3. Tick items here (or move them to issues) as they ship.
4. Re-diff against Pencil periodically — their surface moves.
