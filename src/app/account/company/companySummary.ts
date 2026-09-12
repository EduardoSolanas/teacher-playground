export type CompanyRole = 'owner' | 'admin' | 'member';

export interface CompanyMemberSummary {
  accountId: string;
  displayName: string;
  role: CompanyRole;
  joinedAt: number | null;
}

export interface PendingSeatChange {
  quantity: number;
  operationId: string;
}

export interface CompanySummary {
  companyId: string;
  name: string;
  state: 'active' | 'disabled';
  role: CompanyRole;
  capacity: number;
  pendingSeats: PendingSeatChange | null;
  members: CompanyMemberSummary[];
  invoiceUrl: string | null;
}

function isRole(value: unknown): value is CompanyRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

function toMember(entry: unknown): CompanyMemberSummary | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const accountId = record.accountId ?? record.account_id;
  if (typeof accountId !== 'string' || accountId.length === 0) return null;
  const rawName = record.displayName ?? record.preferredDisplayName ?? record.preferred_display_name;
  const role = record.role;
  if (!isRole(role)) return null;
  const joinedAt = record.joinedAt ?? record.createdAt ?? record.created_at;
  return {
    accountId,
    displayName: typeof rawName === 'string' && rawName.trim() ? rawName : accountId,
    role,
    joinedAt: typeof joinedAt === 'number' ? joinedAt : null,
  };
}

function toPendingSeats(payload: Record<string, unknown>): PendingSeatChange | null {
  const nested = payload.pendingSeats;
  if (nested && typeof nested === 'object') {
    const record = nested as Record<string, unknown>;
    if (typeof record.quantity === 'number' && typeof record.operationId === 'string') {
      return { quantity: record.quantity, operationId: record.operationId };
    }
    return null;
  }
  const quantity = payload.pendingQuantity;
  const operationId = payload.pendingOperationId;
  if (typeof quantity === 'number' && typeof operationId === 'string') {
    return { quantity, operationId };
  }
  return null;
}

const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export function readInviteToken(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('invite');
  if (token === null || !INVITE_TOKEN_PATTERN.test(token)) return null;
  return token;
}

export function readMintedToken(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nested = record.invite;
  const token =
    record.token ??
    (nested && typeof nested === 'object'
      ? (nested as Record<string, unknown>).token
      : undefined);
  if (typeof token !== 'string' || !INVITE_TOKEN_PATTERN.test(token)) return null;
  return token;
}

export function parseCompanySummary(payload: unknown): CompanySummary | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const company = record.company;
  if (!company || typeof company !== 'object') return null;
  const companyRecord = company as Record<string, unknown>;
  const companyId = companyRecord.id ?? companyRecord.companyId;
  const name = companyRecord.name;
  if (typeof companyId !== 'string' || typeof name !== 'string') return null;

  const role = record.role ?? companyRecord.role;
  if (!isRole(role)) return null;

  const capacity = record.capacity ?? record.seatCapacity;
  if (typeof capacity !== 'number') return null;

  const invoiceUrl = record.invoiceUrl ?? record.hostedInvoiceUrl;
  const state = companyRecord.state === 'disabled' ? 'disabled' : 'active';

  const membersPayload = Array.isArray(record.members) ? record.members : [];
  const members = membersPayload
    .map(toMember)
    .filter((member): member is CompanyMemberSummary => member !== null);

  return {
    companyId,
    name,
    state,
    role,
    capacity,
    pendingSeats: toPendingSeats(record),
    members,
    invoiceUrl: typeof invoiceUrl === 'string' && invoiceUrl.length > 0 ? invoiceUrl : null,
  };
}
