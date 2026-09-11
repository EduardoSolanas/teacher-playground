export default function LoadingScreen({
  error,
  onRetry,
}: {
  error?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="session-screen fixed inset-0 z-[1000]">
      <div className="spinner-page" />
      <p className="session-text" role="status" aria-live="polite">
        Connecting to room…
      </p>
      {error && (
        <>
          <p className="app-error" role="alert">{error}</p>
          {onRetry && (
            <button onClick={onRetry} className="btn btn-small">
              Retry
            </button>
          )}
        </>
      )}
    </div>
  );
}
