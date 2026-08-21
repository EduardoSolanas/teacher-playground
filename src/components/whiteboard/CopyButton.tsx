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
        onClick={() => { void handleCopy(); }}
        className={copied ? 'btn-outline btn-small copied' : 'btn-outline btn-small'}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      {failed && (
        <p role="alert" data-testid="whiteboard-copy-error" className="app-error">
          Could not copy. Select the text and copy it manually.
        </p>
      )}
    </>
  );
}
