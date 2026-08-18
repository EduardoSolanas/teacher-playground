import Link from "next/link";

/**
 * Public landing page (SEC-015 sales surface). Static, self-contained, no
 * external assets — the hero is inline SVG so the page stays CSP-strict and
 * fast. Voice targets private tutors (1:1 and small-group tuition), per the
 * owner's market decision recorded in security.md.
 */

const FEATURES = [
  {
    title: "One room per student",
    body: "Give every student their own whiteboard room. The work is there when you both come back — no digging through screenshots before a lesson.",
  },
  {
    title: "You decide who joins",
    body: "Students wait at the door until you let them in. A stranger with the link gets a waiting screen, not your lesson.",
  },
  {
    title: "Talk while you draw",
    body: "Voice and video calling built into the room. Explain the idea out loud while your pen is on the diagram — no second app, no screen juggling.",
  },
  {
    title: "Nothing to install",
    body: "You and your student open a link in the browser and sign in. That's the whole setup, on any laptop or tablet.",
  },
];

/** A whiteboard mid-lesson, drawn as it would look: axes, a curve, an annotation. */
function HeroBoard() {
  return (
    <svg
      viewBox="0 0 560 320"
      role="img"
      aria-label="A tutoring whiteboard with a sketched graph and notes"
      className="w-full h-auto rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      {/* board toolbar */}
      <rect x="0" y="0" width="560" height="34" fill="#f8fafc" />
      <line x1="0" y1="34" x2="560" y2="34" stroke="#e2e8f0" strokeWidth="1" />
      <circle cx="20" cy="17" r="5" fill="#e2e8f0" />
      <circle cx="38" cy="17" r="5" fill="#e2e8f0" />
      <circle cx="56" cy="17" r="5" fill="#e2e8f0" />
      {/* axes */}
      <path d="M90 260 L470 260" stroke="#334155" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M120 288 L120 90" stroke="#334155" strokeWidth="2.5" strokeLinecap="round" />
      {/* hand-drawn parabola */}
      <path
        d="M140 250 C 210 110, 330 110, 430 235"
        fill="none"
        stroke="#4f46e5"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      {/* tutor annotation circle around the turning point */}
      <ellipse
        cx="283"
        cy="146"
        rx="46"
        ry="26"
        fill="none"
        stroke="#d97706"
        strokeWidth="2.5"
        strokeDasharray="1 7"
        strokeLinecap="round"
      />
      <text x="342" y="120" fontFamily="ui-sans-serif, system-ui" fontSize="15" fill="#d97706">
        max here — why?
      </text>
      {/* equation */}
      <text x="150" y="300" fontFamily="ui-sans-serif, system-ui" fontSize="16" fill="#334155">
        y = −(x − 3)² + 4
      </text>
      {/* two live cursors */}
      <path d="M395 196 l0 14 l4 -4 l3 7 l4 -2 l-3 -7 l6 0 z" fill="#4f46e5" />
      <rect x="408" y="206" rx="4" width="42" height="18" fill="#4f46e5" />
      <text x="414" y="219" fontFamily="ui-sans-serif, system-ui" fontSize="11" fill="#ffffff">
        You
      </text>
      <path d="M205 205 l0 14 l4 -4 l3 7 l4 -2 l-3 -7 l6 0 z" fill="#d97706" />
      <rect x="218" y="215" rx="4" width="46" height="18" fill="#d97706" />
      <text x="224" y="228" fontFamily="ui-sans-serif, system-ui" fontSize="11" fill="#ffffff">
        Alex
      </text>
    </svg>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col bg-amber-50/40">
      <header className="max-w-5xl w-full mx-auto px-6 pt-6 flex items-center justify-between">
        <span className="font-semibold text-slate-900">Teacher Playground</span>
        <nav className="flex items-center gap-6 text-sm text-slate-600">
          <Link href="/pricing" className="hover:text-slate-900">Pricing</Link>
          <Link
            href="/whiteboard"
            className="rounded-md bg-slate-900 px-4 py-2 text-white font-medium hover:bg-slate-700"
          >
            Sign in
          </Link>
        </nav>
      </header>

      <main className="flex-1">
        <section className="max-w-5xl mx-auto px-6 pt-16 pb-12 grid gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-slate-900">
              Your online tutoring room
            </h1>
            <p className="mt-5 text-lg text-slate-600 leading-relaxed">
              A shared whiteboard with voice &amp; video, built for 1-to-1 and
              small-group tuition. You sketch, they sketch, you talk it
              through &mdash; and the board is still there next lesson.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                href="/whiteboard"
                className="inline-flex items-center rounded-md bg-indigo-600 px-6 py-3 text-white font-medium hover:bg-indigo-500"
              >
                Open your whiteboard
              </Link>
              <Link
                href="/pricing"
                className="inline-flex items-center px-2 py-3 font-medium text-slate-700 hover:text-slate-900"
              >
                See pricing &rarr;
              </Link>
            </div>
            <p className="mt-4 text-sm text-slate-500">
              Students always join free. Only tutors ever pay.
            </p>
          </div>
          <HeroBoard />
        </section>

        <section className="max-w-5xl mx-auto px-6 pb-20">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="rounded-lg border border-slate-200 bg-white p-6"
              >
                <h2 className="text-lg font-semibold text-slate-900">
                  {feature.title}
                </h2>
                <p className="mt-2 text-slate-600">{feature.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white py-8">
        <div className="max-w-5xl mx-auto px-6 flex flex-wrap items-center justify-center gap-6 text-sm text-slate-500">
          <span>Teacher Playground</span>
          <Link href="/terms" className="hover:text-slate-800">Terms</Link>
          <Link href="/privacy" className="hover:text-slate-800">Privacy</Link>
        </div>
      </footer>
    </div>
  );
}
