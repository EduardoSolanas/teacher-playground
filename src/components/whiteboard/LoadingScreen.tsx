export default function LoadingScreen({
  error,
  onRetry,
}: {
  error?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center bg-slate-50 z-[1000]"
    >
      <div
        className="w-12 h-12 border-[4px] border-slate-200 border-t-blue-500 rounded-full mb-4"
        style={{ animation: 'wb-spin 0.8s linear infinite' }}
      />
      <style>{`
        @keyframes wb-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <p className="m-0 text-base text-slate-800">
        Connecting to room...
      </p>
      {error && (
        <div className="mt-4 text-center">
          <p className="m-0 mb-3 text-sm text-red-500">
            {error}
          </p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="px-5 py-2 rounded-lg border-none bg-blue-500 text-white text-sm cursor-pointer"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
