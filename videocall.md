# Video calls: what exists, what LiveKit gives us, and what to build

## The short answer to "is LiveKit already providing this?"

Mostly yes, and we are not using it.

| Capability | Where it comes from | Used today |
|---|---|---|
| Who is talking | `livekit-client` 2.22.0 — `isSpeaking`, `audioLevel`, `RoomEvent.ActiveSpeakersChanged`, `ParticipantEvent.IsSpeakingChanged` | **No** |
| Mute yourself | `setMicrophoneEnabled` / `setCameraEnabled` | Yes |
| Mute somebody else, enforced | LiveKit server API `MutePublishedTrack` | **No — see below** |
| Choose a device | `switchActiveDevice` | Yes |
| Connection quality per participant | `RoomEvent.ConnectionQualityChanged` | **No** |
| Background blur | `@livekit/track-processors` — a **separate** package | **No** |
| Noise suppression | Browser `getUserMedia` constraints; LiveKit's Krisp filter is a paid add-on | Partially |

Speaking detection is the notable one: it is already in the client we ship, it
costs nothing, and it is the single change that would most improve the call.

Blur is the notable exception in the other direction. It is not in
`livekit-client`. It needs `@livekit/track-processors`, which pulls
`@mediapipe/tasks-vision` and a WASM segmentation model. That is a real cost,
and it lands hardest on exactly the hardware a SEN tutoring session tends to run
on.

## Where this starts

The call today is roughly 1,100 lines across `src/lib/av`, `src/components/av`
and `src/hooks/useAvSession.ts`. It works, and the last stretch of fixes made it
honest — a call is asked for rather than assumed, the controls travel with the
faces, a missing camera no longer reads as a broken call. What it is not is a
call *interface*. It is a panel of tiles.

Three things are worth naming before proposing anything, because they shape the
design more than any visual decision.

### 1. Host mute is advisory, and looks like moderation

`requestMute` publishes a data message asking the target's browser to mute
itself ([livekitProvider.ts:102](src/lib/av/livekitProvider.ts:102)). A client
that ignores the message stays unmuted. Nothing on the server has an opinion.

This is the same shape as the Clear button before it moved server-side: a
control that reads as authority and is in fact a request. In a room of children
it is worse than Clear, because the teacher will believe a disruptive
microphone has been dealt with.

LiveKit's server API has `MutePublishedTrack` on the same twirp service we
already call for `RemoveParticipant`
([livekitRoomService.ts:46](src/lib/av/livekitRoomService.ts:46)). Making host
mute real is a small piece of work in a place we have already built once.

**Nothing else in this document should be built before this.**

### 2. The session polls itself four times a second

`useAvSession` runs `setInterval(refresh, 250)` for the lifetime of the call
([useAvSession.ts:160](src/hooks/useAvSession.ts:160)), copying the whole
session into React state whether or not anything changed. The provider already
subscribes to eleven LiveKit events
([livekitProvider.ts:145-177](src/lib/av/livekitProvider.ts:145)); the poll
exists because those events update a mutable object that React cannot see.

Speaking state changes many times a second per participant. Adding it to a
250 ms poll would make a bad pattern worse. The poll should go first, replaced
by the events that already exist driving a `useSyncExternalStore` subscription.

### 3. The roster already knows about mute, and can only recite it

`PresencePanel` takes `mutedPeerIds` and renders a "Muted" badge
([PresencePanel.tsx:531](src/components/whiteboard/PresencePanel.tsx:531)).
There is no control next to it. The roster is where a teacher already looks to
see who is in the room, and it is the natural place to act on them — the
moderation menu (kick, send to waiting room) is already there.

## The design

### The roster is the call's control surface

Not the video panel. The roster is a list of everyone in the lesson, present
whether or not they have their camera on, and already the place where a teacher
acts on a person.

Each row gains, in this order of importance:

- **A speaking indicator.** Not a badge — a state on the row itself: the
  avatar ring animates while `isSpeaking` is true. It has to be readable
  peripherally, because a teacher watching a child draw is not looking at the
  roster.
- **A microphone state** that is a *button* for the owner and an *indicator*
  for everyone else. Muted, live, or "no microphone".
- **A camera state**, same rule.
- **Connection quality**, only when it is poor. `ConnectionQualityChanged`
  gives us this free, and "their connection is bad" is the answer to most
  "why can't I hear them" questions.

Two deliberate omissions. No per-tile volume slider: it invites a teacher to
solve a hardware problem in software and then forget they did. No "mute
everyone" button: a room where the teacher has silenced every child is a room
where a child cannot ask for help, and the raised-hand cue already exists for
turn-taking.

### The call surface

Three modes, chosen by what the lesson is doing:

**Rail (default).** Faces along one edge, small, out of the way. The board is
the lesson; the call is context. This is roughly what exists, minus the drag —
a floating panel that must be moved is a panel that is in the way.

**Focus.** One face large, the rest small. Triggered by pinning a participant,
or automatically by the active speaker when nobody has pinned. This is where
`ActiveSpeakersChanged` earns its place.

**Off.** Audio only, no tiles. A tutoring session is mostly two people talking
over a shared board, and video is often the least useful thing on screen.
Leaving audio running while hiding the faces should be one press.

Mode belongs to the local viewer, not the room. A teacher choosing focus should
not reframe a child's screen.

### Blur, and whether it is worth it

`@livekit/track-processors@0.7.2` provides `BackgroundBlur()` and virtual
backgrounds, applied as a track processor. It depends on
`@mediapipe/tasks-vision@0.10.14` and a segmentation model downloaded at
runtime.

What that actually costs us:

- **Bundle and model.** The WASM runtime and model are megabytes. They must be
  self-hosted on the existing R2 CDN rather than fetched from Google's, which
  means the release pipeline that publishes Excalidraw assets gains a second
  artefact.
- **CSP.** `script-src`/`worker-src` need `wasm-unsafe-eval`, and the model
  origin needs adding to `connect-src`. We have just been through why widening
  that policy deserves a test each time.
- **CPU.** Per-frame segmentation on the encode path. On a modern laptop it is
  unnoticeable. On the hardware a child is often given, it competes with
  Excalidraw's canvas for the same main thread.

**Recommendation: build it, gate it, default it off, and never enable it
automatically.** Offer it in the device menu next to camera selection, remember
the choice per browser, and disable the control outright when
`navigator.hardwareConcurrency` is low. A teacher who wants their kitchen
hidden should have it; a child on a six-year-old Chromebook should not have it
switched on for them by a heuristic.

If only one of these ships, it should not be blur.

## Sequencing

1. **Server-enforced host mute.** The authority gap. Small, and everything else
   is decoration until it is closed.
2. **Replace the 250 ms poll with event subscriptions.** Everything below adds
   state that changes at speaking frequency; the poll cannot carry it.
3. **Speaking indicator in the roster.** Free, once (2) is done. The largest
   improvement per line changed in the whole document.
4. **Mute and camera controls in the roster.** Owner acts on anyone, everyone
   else sees state.
5. **Connection quality**, when poor.
6. **Rail / focus / off modes.**
7. **Blur**, gated as above.

Steps 1–3 are worth doing on their own and would leave the call meaningfully
better. Steps 6–7 are worth doing only if the call is actually being used for
teaching rather than checking someone is there.

## What I would not build

- **Recording.** A recorded lesson with a child in it is a safeguarding and
  data-protection question, not a feature. It needs a retention policy, a
  lawful basis, and somebody accountable for the storage before a line of code.
- **Virtual backgrounds beyond blur.** Novelty backgrounds are a distraction
  engine in a room full of children.
- **A grid view.** The rooms are two to a handful of people. A grid solves a
  problem this product does not have.
- **Reactions and emoji.** The raised hand exists and is answerable. Adding
  floating hearts to a maths lesson is adding something to ignore.

## Open questions

- **How many people is a room, really?** The design above assumes two to four.
  A room of fifteen wants different answers to focus and to muting.
- **Is video used at all, or is this an audio product with faces attached?**
  If the latter, steps 6–7 are wasted and the roster work is the whole job.
- **Does the teacher ever need to hear a muted child?** If a child mutes
  themselves and then needs help, the raised hand is the only channel. That may
  be enough, or it may be the thing that most needs designing.
