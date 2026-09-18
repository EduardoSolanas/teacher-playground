/**
 * The embedded-documents surface flag (spec/EMBEDDED_DOCUMENTS_SPEC.md,
 * milestone 0). One environment value drives three states:
 *
 * - `off` (the default for anything unrecognised): the surface does not
 *   exist — no upload, no placement, no reads, and no route admits it.
 * - `read-only`: the kill switch. Ready documents stay viewable, but new
 *   uploads, conversions, and placement are refused. Flipping this must
 *   never weaken an authorization check.
 * - `on`: the full surface.
 *
 * Parsing fails closed: a typo in production must hide the surface, never
 * open it.
 */
export type DocumentsMode = 'off' | 'read-only' | 'on';

export function parseDocumentsMode(raw: string | undefined): DocumentsMode {
  if (raw === undefined) return 'off';
  const value = raw.trim().toLowerCase();
  if (value === 'read-only' || value === 'readonly' || value === 'ro') return 'read-only';
  if (value === 'on' || value === 'true' || value === '1') return 'on';
  return 'off';
}

/** Whether any document route may answer at all. */
export function documentsSurfaceVisible(mode: DocumentsMode): boolean {
  return mode !== 'off';
}

/**
 * Whether uploads, conversions, and placement may run. The kill switch
 * (read-only) keeps existing ready documents viewable but stops every write.
 */
export function documentsAllowsWrites(mode: DocumentsMode): boolean {
  return mode === 'on';
}

/** Stable label for logs and the admin surface; never derived from raw env. */
export function documentsModeLabel(mode: DocumentsMode): DocumentsMode {
  return mode;
}
