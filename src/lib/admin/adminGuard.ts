import { normalizeOperatorEmail } from '../company/operator';

/**
 * Parses the admin allowlist for the /admin surface (Env.ADMIN_EMAILS).
 *
 * The same normalization rules as the operator allowlist apply — a comma-
 * separated list of emails, trimmed and lowercased, with empty and invalid
 * entries skipped — so both surfaces agree on what an entry looks like and a
 * candidate normalized for one matches the other's list format. An unset
 * value yields an empty set, which the guards treat as "surface disabled".
 */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  const emails = new Set<string>();
  if (typeof raw !== 'string') return emails;
  for (const entry of raw.split(',')) {
    const email = normalizeOperatorEmail(entry);
    if (email !== null) emails.add(email);
  }
  return emails;
}
