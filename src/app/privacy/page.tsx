import Link from "next/link";

export default function Privacy() {
  return (
    <div className="min-h-screen flex flex-col">
      <main className="flex-1 max-w-2xl mx-auto px-8 sm:px-6 py-16 w-full space-y-6 text-slate-700 leading-relaxed">
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 text-sm">
          Draft &mdash; requires owner and legal review before the service
          charges money.
        </div>

        <h1 className="text-3xl font-bold text-slate-900">Privacy Policy</h1>
        <p>
          This page explains what Teacher Playground collects and why, in
          plain terms.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">
          Signing in
        </h2>
        <p>
          The service does not run its own login form. Sign-in happens
          through Cloudflare Access, using whatever identity provider is
          configured for your school or organization. We receive a
          verified identity assertion from Access; we do not see or store
          your password.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">
          What we store
        </h2>
        <p>
          We store whiteboard content (drawings, notes, and room state) so
          the service can keep a room in sync, restore a board after a
          disconnect, and show a room's history to the people in it. We
          store the minimum account information needed to run rooms,
          waiting-room approvals, and calling: an account identifier, room
          membership, and connection metadata required to operate voice
          and video.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">Students</h2>
        <p>
          Student data is minimized. Students join rooms a tutor has
          approved them into; we do not collect billing information from
          students, and we do not build advertising profiles from
          classroom activity.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">
          No sale of personal data
        </h2>
        <p>
          We do not sell personal data. Information collected to run the
          service is used to run the service, not shared with third
          parties for their own marketing purposes.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">Retention</h2>
        <p>
          Whiteboard content and account data are retained according to
          the plan a room's owner is on; see{" "}
          <Link href="/pricing" className="underline">
            pricing
          </Link>{" "}
          for current retention windows. Rooms and their content are
          removed once the retention period for inactive rooms elapses.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">Contact</h2>
        <p>
          Questions or requests about your data can be directed to the
          owner of the repository this service is built from.
        </p>
      </main>

      <footer className="border-t border-slate-200 py-8">
        <div className="max-w-2xl mx-auto px-8 sm:px-6 flex flex-wrap items-center justify-center gap-6 text-sm text-slate-500">
          <Link href="/" className="hover:text-slate-800">
            Home
          </Link>
          <Link href="/terms" className="hover:text-slate-800">
            Terms
          </Link>
        </div>
      </footer>
    </div>
  );
}
