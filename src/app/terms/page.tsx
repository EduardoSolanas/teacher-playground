import Link from "next/link";

export default function Terms() {
  return (
    <div className="min-h-screen flex flex-col">
      <main className="flex-1 max-w-2xl mx-auto px-8 sm:px-6 py-16 w-full space-y-6 text-slate-700 leading-relaxed">
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 text-sm">
          Draft &mdash; requires owner and legal review before the service
          charges money.
        </div>

        <h1 className="text-3xl font-bold text-slate-900">Terms of Service</h1>
        <p>
          These terms cover the use of Teacher Playground, a collaborative
          whiteboard service for classrooms.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">Accounts</h2>
        <p>
          Access to the service is granted through Cloudflare Access
          sign-in. Tutors create and own rooms; students authenticate to
          join a room a tutor has invited them to. We do not maintain a
          separate password of our own &mdash; sign-in is handled by the
          identity provider configured behind Cloudflare Access.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">
          Content you put on the whiteboard
        </h2>
        <p>
          Whiteboard content (drawings, notes, and related room data) is
          stored so the service can run: keeping the board in sync between
          participants, restoring it after a disconnect, and enforcing the
          room's retention policy. You keep ownership of what you create.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">Acceptable use</h2>
        <p>
          The service is for classroom collaboration. Do not use it to
          upload unlawful content, to harass other participants, or to
          attempt to access rooms or accounts you do not have permission to
          use.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">
          Plans and payment
        </h2>
        <p>
          Some plan tiers may require payment from the teacher account that
          owns a room. Students never pay and never see billing UI. Payment
          terms will be finalized before any charge is introduced; see{" "}
          <Link href="/pricing" className="underline">
            pricing
          </Link>{" "}
          for the current, unpriced plan proposal.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">Termination</h2>
        <p>
          We may suspend or terminate access for accounts that violate
          these terms or misuse the service. You may stop using the
          service, and delete your rooms, at any time.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">Changes</h2>
        <p>
          These terms may change as the service develops. Material changes
          will be reflected on this page.
        </p>

        <h2 className="text-xl font-semibold text-slate-900">Contact</h2>
        <p>
          Questions about these terms can be directed to the owner of the
          repository this service is built from.
        </p>
      </main>

      <footer className="border-t border-slate-200 py-8">
        <div className="max-w-2xl mx-auto px-8 sm:px-6 flex flex-wrap items-center justify-center gap-6 text-sm text-slate-500">
          <Link href="/" className="hover:text-slate-800">
            Home
          </Link>
          <Link href="/privacy" className="hover:text-slate-800">
            Privacy
          </Link>
        </div>
      </footer>
    </div>
  );
}
