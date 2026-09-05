# Call panel improvements

Scope: how the call looks and where it sits. No change to who may start or end a
call, to the A/V transport, or to the call lifecycle settled in R04 — the call
belongs to the room and survives the host disconnecting.

Written against `a30c125..f80b09a`. Competitor evidence is from Pencil Spaces
and Lessonspace product/help screenshots reviewed 2026-09-05.

## Why

Four things, in the order they were asked for:

1. A person with their camera off is an anonymous grey circle. It should be
   their initial, in their own colour.
2. Destructive and "off" states are outlined, not filled. Both competitors fill
   them solid red, and it reads at a glance.
3. The panel floats over the board and is draggable. Both competitors dock video
   to a right rail.
4. The control buttons are a 3-column grid inside the floating panel with no
   grouping. Layout choice below is mine.

## What is already there (do not rebuild it)

- Live camera already renders: `AvSessionPanel.tsx:241` picks `VideoTrack` when
  `participant.camOn`, and falls back to the initials block at `:248`. **The
  "real feed when the camera is on" half of item 1 already works.** Only the
  fallback needs work.
- `getInitials` already produces initials, rendered at `:251`.
- `resolveParticipantInfo` (`:120`) already resolves display name, initials and
  hand-raised, including the "(you)" case.
- Speaking state already rings the tile emerald (`:236`).
- Screen share, hand raised, poor-connection and fullscreen/PiP badges all exist.

**The single most useful discovery:** `WhiteboardUser`
(`src/types/whiteboard.ts:145`) already carries `color` and `isHost`, and
`RoomClient` already passes those users into the panel — but `AvUser`
(`AvSessionPanel.tsx:15`) declares only `peerId`, `userName`, `accountId` and
`handRaised`, so **the colour and the host flag are thrown away at the type
boundary**. Widening that interface is most of the work for items 1 and 4.

That colour comes from `generateColor(name)` in `UserNamePrompt.tsx:17` and is
the same colour the person's cursor uses on the board. Reusing it means a
student's cursor and their video tile match, which is a better outcome than any
new palette would be. **Do not invent a second palette.**

## 1. Identity: first initial, in their colour

**Fallback tile, camera off.** One letter, not two: the first initial of the
display name, matching the request and both competitors. `getInitials` is still
used for the roster elsewhere — add a separate first-initial helper rather than
changing it, and check its other callers before touching it.

Rendering, following Lessonspace: a **coloured ring around a dark fill, with the
letter in the person's colour** — not a solid colour fill.

Reason, and this is load-bearing: the palette in `UserNamePrompt.tsx` includes
`#f1c40f` (yellow) and `#607d8b` (slate). As a solid fill behind white text the
first fails contrast badly and the second is nearly invisible on our
`slate-950/80` tile. Ring + tinted letter on a dark fill keeps every one of the
ten legible, and it is what Lessonspace does.

- Ring: 2px, `user.color`.
- Letter: `user.color`, semibold, sized to the tile (it is currently a fixed
  `h-9 w-9`, which is too small for a docked rail tile — scale it).
- Fill: keep the existing dark gradient.
- Keep the "Camera off" caption. It is the non-colour signal.

**Unknown people.** `resolveParticipantInfo` already falls back to the identity
string when no user row matches. Keep a neutral grey there — do not hash a
colour out of a peer id, because it will not match that person's cursor and two
sources of truth for one person's colour is how they drift.

**Host marker.** Lessonspace puts a 👑 on the tutor's tile. `isHost` is already
on `WhiteboardUser` and free once `AvUser` carries it. Worth doing at the same
time; it is the only in-call signal of who is teaching.

## 2. Colour on destructive and "off" states

Today `Leave` is slate-outlined and `End for all` is rose-outlined, sitting
adjacent. Mic-muted and cam-off are also outlines.

- **Muted mic / camera off: solid red fill**, white glyph (Lessonspace). This is
  the clearest state signal in any competitor screenshot reviewed.
- **`End for all`: solid red fill.** It ends the call for a whole class.
- **`Leave`: stays neutral.** It affects only you, and colouring both red makes
  the dangerous one indistinguishable from the safe one.
- Never colour alone. Every state keeps its icon, its `title`, and an
  `aria-pressed` or equivalent, so the meaning survives a colourblind viewer and
  a screen reader.

**Position matters more than colour, and we are currently the worst of the
three.** Pencil Spaces puts `← Back to board` bottom-left and `End call`
bottom-right — opposite corners. Lessonspace hides `End Session` behind a
dropdown caret. Ours are side by side in a compact header, which is the easiest
to mis-click. Separate them: `Leave` with the controls, `End for all` divided
off at the far end of the cluster.

**Confirmation.** `End for all` hangs up on the room in one click with no
confirm step. `ClearBoardModal` already exists, is keyboard-accessible, and is
the established pattern here for exactly this class of action. Reuse it.

## 3. Position: dock to a right rail

Replace the floating draggable panel with a right-edge sidebar. Both competitors
do this, and the reason is that in a whiteboard product the board is the hero:
a floating panel occludes the one thing the lesson is about, and someone has to
keep moving it.

- Fixed to the right edge, full height of the board area.
- Width `clamp(11rem, 18vw, 15rem)`. Tiles are 16:9 and stack vertically.
- Collapsible to a thin strip with a participant count, so the board can have
  the full width back. Persist the collapsed choice per viewer in
  `localStorage` — it is a per-viewer convenience, and the existing
  `persistence.ts` guards are the model for touching storage safely.
- **Below `sm:` the rail becomes a horizontal strip along the bottom.** A 15rem
  sidebar on a phone leaves nothing for the board. This is the case most likely
  to be skipped; it should be in the same slice as the rail, not deferred.
- The board's canvas must shrink to the remaining width rather than being
  overlapped, so nothing is drawn underneath the rail and lost.

Dropping the drag handle removes the `⠿` control at `AvSessionPanel.tsx:530`.

## 4. Control layout — decision

Both competitors were considered. **Lessonspace uses two rails** (tiles in one
column, a separate vertical icon rail beside it) and **Pencil Spaces uses a
bottom bar** in a dedicated full-screen call view — a view we do not have and
should not build, because our call is always beside a live board.

**Decision: one column. Tiles stacked, one control cluster pinned to the bottom
of the rail.** A second vertical rail costs horizontal space we do not have next
to a whiteboard, and a bottom bar belongs to a full-screen call view we are not
building. One column is also simply less to get wrong.

The cluster, in order:

```
[ mic ] [ camera ] [ screen ]        <- primary, most-used, equal weight
[ settings ] [ reactions ] [ chat ]  <- secondary, only those that exist today
------------------------------------ <- divider
[ Leave ]                [ End for all ]   <- End for all host-only, solid red
```

- Only build rows for features that exist. `CallControls.tsx` today has mic,
  camera and screen share. Do not add reactions or chat as dead buttons because
  a competitor has them.
- Icon-only with `title` and an accessible name, as now — labels do not fit the
  rail width.
- Keep the existing disabled-while-connecting behaviour and the comment
  explaining it (`CallControls.tsx:17`): a button that is live before the
  devices are ready is a button that does nothing when pressed.

## Slices

Each is one red/green cycle with real objects, per `AGENTS.md`. In order, each
shippable alone:

1. **Widen `AvUser`** with `color` and `isHost`; thread them through
   `resolveParticipantInfo`. Pure plumbing, no visual change. Test: a user row
   with a colour reaches the tile.
2. **First-initial avatar in the person's colour**, ring + tinted letter. Test
   the fallback renders the first initial and the user's colour, that an unknown
   participant stays neutral, and that a live camera still replaces it — the
   last one guards the half that already works.
3. **Host crown** on the host's tile. Negative test: a non-host tile has none.
4. **Solid red for muted/cam-off and for `End for all`**, plus the divider and
   separation. Test state and accessible name, not class names.
5. **Confirmation on `End for all`** via `ClearBoardModal`. Test that cancel
   never ends the call and confirm ends it exactly once.
6. **Dock the rail**, remove the drag handle, add collapse + persistence.
7. **Responsive**: horizontal strip below `sm:`.

Slices 1–5 are independent of the layout move, so they can land while the rail
is still floating. Do 6 and 7 together or the phone case will be left broken.

## Non-goals

- No change to call authorization, lifecycle, or transport.
- No new colour palette; reuse the board's per-user colour.
- No full-screen call view.
- No reactions, chat, recording, or layout switchers. They are competitor
  features we have no backing for, and a button that does nothing is worse than
  no button.
- No new dependency for the rail or the avatar.

## Open question

The palette in `UserNamePrompt.tsx` was chosen for cursor labels on a light
board, not for text on a dark tile. Ring-and-letter keeps all ten legible, but
if a solid fill is ever wanted the palette needs a dark-surface variant. Not
needed for anything above.
