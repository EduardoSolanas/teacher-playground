'use client';

import { useEffect, useRef, useState } from 'react';

const CONFIRM_MS = 2000;

/**
 * Copy one value to the clipboard, and say whether it worked.
 *
 * The failure path is the reason this is a component rather than an onClick.
 * Clipboard writes reject on an insecure origin and when the document is not
 * focused, and a copy that silently fails is worse than no button: the teacher
 * pastes whatever was there before and sends a student the wrong link.
 */
export default function CopyButton({
  value,
  label,
}: {
  /** The exact text to place on the clipboard. */
  value: string;
  /** What is being copied, for the accessible name: "Copy class PIN". */
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
  }, []);

  if (!value) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFailed(false);
      setCopied(true);
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), CONFIRM_MS);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  };

  return (
    <>
      <button
        type="button"
        data-testid="whiteboard-copy-btn"
        aria-label={`Copy ${label}`}
        title={copied ? 'Copied' : `Copy ${label}`}
        onClick={() => { void handleCopy(); }}
        className={copied ? 'copy-icon-btn copied' : 'copy-icon-btn'}
      >
        {copied ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
        {/* The state a sighted user reads from the tick, for everyone else. */}
        <span className="sr-only">{copied ? 'Copied' : 'Copy'}</span>
      </button>
      {failed && (
        <p role="alert" data-testid="whiteboard-copy-error" className="app-error">
          Could not copy. Select the text and copy it manually.
        </p>
      )}
    </>
  );
}
