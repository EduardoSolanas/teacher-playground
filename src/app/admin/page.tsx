import AdminUsersPanel from '@/components/admin/AdminUsersPanel';

export default function AdminPage() {
  return (
    <div className="app-screen pt-[calc(3rem+env(safe-area-inset-top))]">
      <main className="app-main">
        <div className="paper-card">
          <h1 className="app-title">Admin</h1>
          <AdminUsersPanel />
        </div>
      </main>
    </div>
  );
}
