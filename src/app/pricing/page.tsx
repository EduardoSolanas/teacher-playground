import Link from "next/link";

/**
 * Public pricing page (SEC-015 sales surface). Tiers mirror the membership
 * structure recorded in security.md: sized for private tutors — a room per
 * student, value in retention and A/V rather than seat counts. No checkout
 * UI and no price input exists here; the only action is signing in.
 */

const TIERS = [
  {
    name: "Free",
    price: "$0",
    tagline: "Everything you need to tutor one or two students.",
    features: [
      "2 student rooms",
      "3 people per room — you and up to two students",
      "Voice & video calling",
      "Boards kept for 7 days between lessons",
    ],
    cta: "Start tutoring free",
    highlight: false,
  },
  {
    name: "Tutor Pro",
    price: "Monthly or annual — pricing coming soon",
    tagline: "Room for your whole student list, and boards that keep for a term.",
    features: [
      "20 student rooms — one per student or group",
      "Up to 10 people per room for group classes",
      "Voice & video calling",
      "Boards kept for 90 days",
    ],
    cta: "Open your whiteboard",
    highlight: true,
  },
];

export default function Pricing() {
  return (
    <div className="min-h-screen flex flex-col bg-amber-50/40">
      <header className="max-w-5xl w-full mx-auto px-8 sm:px-6 pt-6 flex items-center justify-between">
        <Link href="/" className="font-semibold text-slate-900">
          Teacher Playground
        </Link>
        <nav className="flex items-center gap-6 text-sm text-slate-600">
          <Link
            href="/whiteboard"
            className="rounded-md bg-slate-900 px-4 py-2 text-white font-medium hover:bg-slate-700"
          >
            Sign in
          </Link>
        </nav>
      </header>

      <main className="flex-1 max-w-4xl mx-auto px-8 sm:px-6 py-16 w-full">
        <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 text-center">
          Simple pricing for tutors
        </h1>
        <p className="mt-3 text-center text-slate-600">
          Students always join free &mdash; only tutors ever pay.
        </p>

        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-6">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={
                tier.highlight
                  ? "rounded-lg border-2 border-indigo-600 bg-white p-8 flex flex-col shadow-sm"
                  : "rounded-lg border border-slate-200 bg-white p-8 flex flex-col"
              }
            >
              <h2 className="text-xl font-semibold text-slate-900">{tier.name}</h2>
              <p className="mt-1 text-slate-500">{tier.price}</p>
              <p className="mt-3 text-slate-700">{tier.tagline}</p>
              <ul className="mt-6 space-y-2 text-slate-700 flex-1">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <span aria-hidden="true" className="text-indigo-600">✓</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <Link
                href="/whiteboard"
                className={
                  tier.highlight
                    ? "mt-8 inline-flex items-center justify-center rounded-md bg-indigo-600 px-6 py-3 text-white font-medium hover:bg-indigo-500"
                    : "mt-8 inline-flex items-center justify-center rounded-md bg-slate-900 px-6 py-3 text-white font-medium hover:bg-slate-700"
                }
              >
                {tier.cta}
              </Link>
            </div>
          ))}
        </div>

        <p className="mt-10 text-center text-sm text-slate-500 max-w-2xl mx-auto">
          If you ever downgrade, nothing is deleted: rooms over the Free limit
          are archived and readable, and come back exactly as they were when
          you upgrade again.
        </p>
      </main>

      <footer className="border-t border-slate-200 bg-white py-8">
        <div className="max-w-5xl mx-auto px-8 sm:px-6 flex flex-wrap items-center justify-center gap-6 text-sm text-slate-500">
          <Link href="/" className="hover:text-slate-800">Home</Link>
          <Link href="/terms" className="hover:text-slate-800">Terms</Link>
          <Link href="/privacy" className="hover:text-slate-800">Privacy</Link>
        </div>
      </footer>
    </div>
  );
}
