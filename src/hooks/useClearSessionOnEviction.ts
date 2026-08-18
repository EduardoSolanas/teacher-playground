import { useEffect } from 'react';

export function useClearSessionOnEviction(
  clearSession: () => void,
  flags: { wasKicked: boolean; wasRejected: boolean; wasSuspended: boolean },
): void {
  const { wasKicked, wasRejected, wasSuspended } = flags;
  useEffect(() => {
    if (!wasKicked && !wasRejected && !wasSuspended) return;
    clearSession();
  }, [wasKicked, wasRejected, wasSuspended, clearSession]);
}
