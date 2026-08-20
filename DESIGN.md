# DESIGN.md — teacher-playground design system

Extracted from the existing UI (whiteboard room + marketing pages) so every
future component traces back to one token source. This is the system the code
already uses; new work must not introduce orphan values.

## 1. Product & feel

A tutoring whiteboard used live in classrooms: teacher host + students
(guests), voice, waiting queue, raised hands. The canvas is the product — every
piece of chrome is a light, floating layer that can get out of the way.
Feel: calm, precise, tool-like. Light surfaces on slate; dark glass for
floating controls; one warm attention color (amber) reserved for people
waiting or raising hands.

## 2. Color

### Brand palette (shared base — `public/brand.css`)

Every surface (marketing pages AND app pages) inherits these tokens from
`public/brand.css`; consume from Tailwind as `bg-[var(--paper)]` etc:
- paper `#faf7f0` page background (warm paper) · paper2 `#f3eee2` recessed strips
- ink `#26241f` primary text · ink2 `#4b4740` secondary · mut `#7a756b` muted
- rule `#c9d6ea` blue rules · line `#e6e0d2` hairlines on paper
- blue `#2a5db0` primary actions/links · blue-d `#1e4685` hover
- red `#c0392b` accents: topline, emphasis, destructive

Shared component classes live in the same file: `.btn` (blue, 2px radius,
hard `2.5px 2.5px 0` ink shadow, `:disabled` greyed), `.brand-topline` (4px red
bar), `.serif` (Georgia headings), `.wrap`/`.narrow`, `.note-block`/`.draft`
cards. Cards are white with a `var(--line)` hairline, 2–3px radius and a hard
offset shadow (`5px 6px 0 rgba(38,36,31,.06)`) — never soft blurred shadows.
Serif (Georgia, weight 400) is the heading voice on every page.

### In-room overlay system (whiteboard chrome)

Neutrals — slate family, tinted cool:
- Canvas background: `var(--paper)`; ink `slate-900` (`#0f172a`)
- Light surfaces: `white/95` + `backdrop-blur` (glass) over the canvas,
  borders `slate-200`, secondary text `slate-500`, muted `slate-400`
- Dark glass (floating chrome: tool sidebar, bottom bar, back link):
  `slate-900/95` + `backdrop-blur-md`, border `slate-700/80`, text
  `slate-200`, hover `slate-800`→`slate-700`, destructive hover `red-400`
- Menu/dropdown surface: `slate-800` solid, border `slate-700`, text `slate-200`/`#e5e7eb`

Accents — one job each, never mixed:
- Emerald (`emerald-500`/`600`): host identity, approve/let-in, success
- Amber (`amber-500`/`600`, bg `amber-50`/`#fef3c7`): waiting queue, raised
  hand, attention badges
- Red (`red-500`/`600`): kick, reject, destructive
- Sky (`sky` family, legacy self-highlight `#e8f4fd`, default user color
  `#3498db`): the local user's own row/cursor only
- Indigo (`#6366f1`): the global focus-visible ring, nothing else
- Brand blue (`var(--blue)`): primary actions inside app chrome (create room,
  save, enable guest join) — same blue as the marketing pages

No gradients, no purple/blue washes, saturation kept low. Shadows on paper
surfaces are hard offsets tinted ink (`rgba(38,36,31,.06–.08)`); shadows inside
the room overlay are slate-tinted (`shadow-slate-900/10`–`/30`).

## 3. Typography

System font stack (no webfont), inherited via `font: inherit`. The app lives
at micro sizes — this scale is the contract:
- Roster/menu/body: `text-[13px]`, weight 400/500/600 (self = 600)
- Controls & buttons: `text-[11px]`–`text-[13px]`, `font-semibold`
- Micro-labels / counts / badges: `text-[10px]`–`text-[12px]`, `font-semibold`
  or `font-bold`; tiny uppercase tracking-wider labels are the house idiom
  for field labels
- Marketing pages use a display scale (clamp, e.g. hero 2.5rem→3.6rem) —
  app chrome never does

## 4. Space, radius, layout

- Spacing rhythm: 0.5/1/1.5/2 (Tailwind scale); rows `p-2`–`p-2.5`, gaps
  `gap-1`–`gap-2`, panel padding `p-1`–`p-3`
- Radius: `rounded-lg` inner controls, `rounded-xl` floating surfaces and
  prompts, `rounded-2xl` the canvas container, `rounded-full` avatars/badges
- Floating chrome respects `env(safe-area-inset-*)` via
  `max()/calc()` insets; full-height uses `100dvh`-safe patterns, never
  `h-screen` for heroes
- Fixed elements are layered, never push layout (canvas is sized with
  `calc()` insets on `sm:` up only)

## 5. Component patterns

- Floating panel (presence): right rail on `sm:`, full-height glass
  (`white/95` + blur + `border-l`), width `min(220px, 85vw)` expanded,
  slim handle collapsed
- Row: avatar circle (first letter, white on user color, `h-6 w-6`) + name
  (truncate) + inline state chips; state reads from background tint +
  chip, never color alone
- Chips: tiny `text-[10px] font-semibold` colored text (`Host` emerald,
  `Waiting`/`Hand raised` amber, `Muted` amber) — no pill borders
- Kebab menu: `h-6 w-6 rounded-md bg-slate-700` square with icon, opens a
  fixed dark menu (`slate-800`) with full-width text-left items + 14px SVG
  icons; same menu from row click and kebab
- Buttons: `Let in` emerald filled; destructive items turn
  `red-600`/`amber-600` on hover only; all transitions `duration-150`
- Modal/prompt: centered `rounded-xl` white card on `black/60`, `p-8`,
  `min-w-[320px]`, `shadow-xl`
- Empty state: short muted `text-xs slate-400` line, no illustration

## 6. Motion

- House transition: `transition-colors duration-150` on all interactive
  elements; pressed feedback via background shift (no scale currently)
- Panel show/hide: width/transform at 200ms ease, GPU-friendly
  (`transform`/`opacity` preferred; the existing width transition may stay)
- One-shot cues (raised hand): keyframed `transform`+`opacity` only, with a
  soft glow `drop-shadow`; ~2.8s total, forwards fill
- No scroll-triggered animation, no parallax, no spring libraries

## 7. Z-index & stacking (the scale — no ad-hoc values)

`z-[200]` bottom controls → `z-[400]` alerts → `z-[1000]` modals/prompts →
`z-[1100]` fixed nav links → `z-[1200]` presence rail → `z-[1250]` menus
opened from the rail → `z-[1300]` transient full-screen cues. Nothing above
1300. Focus ring `:focus-visible` is always visible (indigo, 2px, offset 2).

## 8. Accessibility contract

Every icon-only control has `title` + `aria-*` where state exists
(`aria-expanded` on toggles). Interactive rows get cursor affordance and
click + context-menu paths; menus close on outside pointerdown and Escape.
Status changes announce via `role="status"`/`aria-live="polite"`. No emoji as
UI icons — inline SVG only.
