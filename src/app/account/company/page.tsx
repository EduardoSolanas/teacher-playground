import CompanyAdminPanel from './CompanyAdminPanel';

export default function CompanyPage() {
  return (
    <div className="app-screen pt-[calc(3rem+env(safe-area-inset-top))]">
      <main className="app-main">
        <div className="paper-card">
          <h1 className="app-title">Company</h1>
          <p className="app-sub">Manage your company seats and invitations.</p>
          <CompanyAdminPanel />
        </div>
      </main>
    </div>
  );
}
