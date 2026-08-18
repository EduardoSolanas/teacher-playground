import { useEffect, useRef } from 'react';

export function useClearSessionOnEviction(
  clearSession: () => void,
  flags: { wasKicked: boolean; wasRejected: boolean; wasSuspended: boolean },
): void {
  const { wasKicked, wasRejected, wasSuspended } = flags;
  const clearedOnPageHideRef = useRef(false);

  useEffect(() => {
    if (!wasKicked && !wasRejected && !wasSuspended) return;
    clearSession();
  }, [wasKicked, wasRejected, wasSuspended, clearSession]);

  useEffect(() => {
    const onPageHide = () => {
      if (clearedOnPageHideRef.current) return;
      clearedOnPageHideRef.current = true;
      clearSession();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [clearSession]);
}
