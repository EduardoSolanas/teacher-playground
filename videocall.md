# Video calls: what exists, what LiveKit gives us, and what to build

> **Status (updated September 2026).** This memo began as an audit of the call
> as it then stood, with a seven-step sequencing plan. **Steps 1–6 have been
> built and shipped**; the sections below now describe what shipped and where.
> What remains open is background blur (step 7) and the three open questions
> at the end. The original diagnoses are kept because they explain why the
> call is shaped the way it is.

## The short answer to "is LiveKit already providing this?"

Yes where it matters. The gaps this memo named are closed.

| Capability | Where it comes from | Used today |
|---|---|---|
| Who is talking | `livekit-client` — `isSpeaking`, `RoomEvent.ActiveSpeakersChanged`, `ParticipantEvent.IsSpeakingChanged` | **Yes** — speaking indicator on roster rows |
| Mute yourself | `setMicrophoneEnabled` / `setCameraEnabled` | Yes |
| Mute somebody else, enforced | LiveKit server API `MutePublishedTrack` | **Yes — server-enforced** |
| Choose a device | `switchActiveDevice` | Yes |
| Connection quality per participant | `RoomEvent.ConnectionQualityChanged` | **Yes** — roster badge, shown only when poor or lost |
| Background blur | `@livekit/track-processors` — a **separate** package | **No** — the one deliberate remainder; see below |
| Noise suppression | Browser `getUserMedia` constraints; LiveKit's Krisp filter is a paid add-on | Partially |

Blur is still the notable exception. It is not in `livekit-client`. It needs
`@livekit/track-processors`, which pulls `@mediapipe/tasks-vision` and a WASM
segmentation model. That is a real cost, and it lands hardest on exactly the
hardware a SEN tutoring session tends to run on. Nothing in the dependency
tree references either package yet.

## What was wrong when this was written, and what changed

### 1. Host mute was advisory, and looked like moderation — **fixed**

When this was written, `requestMute` published a data message asking the
target's browser to mute itself. A client that ignored the message stayed
unmuted, and nothing on the server had an opinion. That was the same shape as
the Clear button before it moved server-side: a control that reads as
authority and is in fact a request. In a room of children it was worse than
Clear, because the teacher would believe a disruptive microphone had been
dealt with.

Now mute is enforced by the server. The client posts to
`POST /api/av/mute` (`useAvSession.ts`, `requestMute`); `RoomDO` calls
`muteLiveKitParticipant`
([livekitRoomService.ts](src/lib/av/livekitRoomService.ts)), which resolves
the participant's published track via Room Service `GetParticipant` and mutes
it with `MutePublishedTrack` — the same twirp service we already called for
`RemoveParticipant`. A client that ignores anything stays muted anyway.

### 2. The session polled itself four times a second — **fixed**

When this was written, `useAvSession` ran `setInterval(refresh, 250)` for the
lifetime of the call, copying the whole session into React state whether or
not anything changed. The provider already subscribed to eleven LiveKit
events ([livekitProvider.ts](src/lib/av/livekitProvider.ts)); the poll existed
because those events updated a mutable object React could not see. Speaking
state changes many times a second per participant, so the poll could not have
carried it.

Now the poll is gone. The session state machine is exposed through
`subscribe` / `getSnapshot` and React reads it with `useSyncExternalStore`
([useAvSession.ts](src/hooks/useAvSession.ts)); the provider's events mutate
the store, which notifies subscribers. That is what made the speaking
indicator (step 3) possible at all.

### 3. The roster knew about mute, and could only recite it — **fixed**

When this was written, `PresencePanel` took `mutedPeerIds` and rendered a
"Muted" badge with no control next to it. The reasoning stands: the roster is
where a teacher already looks to see who is in the room, and the moderation
menu (kick, send to waiting room) was already there.

Now each roster row carries the participant's live A/V state (`micMuted`,
`micPresent`, `camOn`, `quality`) and, for a moderator, a mute control —
audio or video — beside the existing moderation actions
([PresencePanel.tsx](src/components/whiteboard/PresencePanel.tsx),
`canMuteAv` / `onMutePeer`).

## The design

### The roster is the call's control surface — **shipped**

Not the video panel. The roster is a list of everyone in the lesson, present
whether or not they have their camera on, and already the place where a
teacher acts on a person. Each row gained, in this order of importance:

- **A speaking indicator.** Not a badge — a state on the row itself, readable
  peripherally. Precedence on the row is: no mic > speaking > muted > plain
  live.
- **A microphone state** that is a *button* for a moderator and an
  *indicator* for everyone else. Muted, live, or "no microphone".
- **A camera state**, same rule.
- **Connection quality**, only when it is poor or lost —
  `ConnectionQualityChanged` gives us this free, and "their connection is
  bad" is the answer to most "why can't I hear them" questions. Good,
  excellent, and unknown render nothing.

The two deliberate omissions held: there is no per-tile volume slider and no
"mute everyone" button. A room where the teacher has silenced every child is
a room where a child cannot ask for help, and the raised-hand cue already
exists for turn-taking.

### The call surface — **shipped**

Three modes, chosen by what the lesson is doing, owned by the local viewer —
a teacher choosing focus does not reframe a child's screen
(`AvPanelMode` in [AvSessionPanel.tsx](src/components/av/AvSessionPanel.tsx)):

**Rail (default).** Faces along one edge, small, out of the way. The board is
the lesson; the call is context. No dragging.

**Focus.** One face large, the rest small. Triggered by pinning a
participant, or automatically by the active speaker when nobody has pinned —
with a fallback to the first tile when nobody is speaking. This is where
`ActiveSpeakersChanged` earns its place.

**Off.** Audio only, no tiles. A tutoring session is mostly two people
talking over a shared board, and video is often the least useful thing on
screen. Off hides the faces and keeps the audio — the room audio renderer
stays mounted in every mode, so switching to off and back is one press.

### Blur, and whether it is worth it — **not built; recommendation unchanged**

`@livekit/track-processors@0.7.2` provides `BackgroundBlur()` and virtual
backgrounds, applied as a track processor. It depends on
`@mediapipe/tasks-vision@0.10.14` and a segmentation model downloaded at
runtime.

What that actually costs us:

- **Bundle and model.** The WASM runtime and model are megabytes. They must
  be self-hosted on the existing R2 CDN rather than fetched from Google's,
  which means the release pipeline that publishes Excalidraw assets gains a
  second artefact.
- **CSP.** `script-src`/`worker-src` need `wasm-unsafe-eval`, and the model
  origin needs adding to `connect-src`. We have just been through why
  widening that policy deserves a test each time.
- **CPU.** Per-frame segmentation on the encode path. On a modern laptop it
  is unnoticeable. On the hardware a child is often given, it competes with
  Excalidraw's canvas for the same main thread.

**Recommendation: build it, gate it, default it off, and never enable it
automatically.** Offer it in the device menu next to camera selection,
remember the choice per browser, and disable the control outright when
`navigator.hardwareConcurrency` is low. A teacher who wants their kitchen
hidden should have it; a child on a six-year-old Chromebook should not have
it switched on for them by a heuristic.

If only one of these ships, it should not be blur.

## Sequencing

1. ✅ **Server-enforced host mute.** Shipped — `POST /api/av/mute` →
   `RoomDO` → `MutePublishedTrack`.
2. ✅ **Replace the 250 ms poll with event subscriptions.** Shipped —
   `useSyncExternalStore` over the session store.
3. ✅ **Speaking indicator in the roster.** Shipped — row state, event-driven.
4. ✅ **Mute and camera controls in the roster.** Shipped — moderator-gated,
   audio and video.
5. ✅ **Connection quality, when poor.** Shipped — shown only for poor/lost.
6. ✅ **Rail / focus / off modes.** Shipped — local viewer state, active
   speaker focus, pinning, audio-only off.
7. ⬜ **Blur**, gated as above. The only sequencing item left.

## What I would not build

- **Recording.** A recorded lesson with a child in it is a safeguarding and
  data-protection question, not a feature. It needs a retention policy, a
  lawful basis, and somebody accountable for the storage before a line of
  code.
- **Virtual backgrounds beyond blur.** Novelty backgrounds are a distraction
  engine in a room full of children.
- **A grid view.** The rooms are two to a handful of people. A grid solves a
  problem this product does not have.
- **Reactions and emoji.** The raised hand exists and is answerable. Adding
  floating hearts to a maths lesson is adding something to ignore.

None of these exist, and none should.

## Open questions

Still open, and more pressing now that steps 1–6 have shipped:

- **How many people is a room, really?** The shipped design assumes two to
  four. A room of fifteen wants different answers to focus and to muting.
- **Is video used at all, or is this an audio product with faces attached?**
  If the latter, the remaining blur work is wasted and the roster work was
  the whole job.
- **Does the teacher ever need to hear a muted child?** If a child mutes
  themselves and then needs help, the raised hand is the only channel. That
  may be enough, or it may be the thing that most needs designing.
