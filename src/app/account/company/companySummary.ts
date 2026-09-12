export type CompanyRole = 'owner' | 'admin' | 'member';

export interface CompanyMemberSummary {
  accountId: string;
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
}

interface CompanySubscriptionSummary {
  quantity: number;
  pendingQuantity: number | null;
  pendingOperationId: string | null;
}

function isRole(value: unknown): value is CompanyRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

function toMember(entry: unknown): CompanyMemberSummary | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const accountId = record.accountId;
  if (typeof accountId !== 'string' || accountId.length === 0) return null;
  const role = record.role;
  if (!isRole(role)) return null;
  const joinedAt = record.createdAt;
  return {
    accountId,
    role,
    joinedAt: typeof joinedAt === 'number' ? joinedAt : null,
  };
}

function toSubscription(value: unknown): CompanySubscriptionSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const quantity = record.quantity;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
    return null;
  }
  return {
    quantity,
    pendingQuantity:
      typeof record.pendingQuantity === 'number' ? record.pendingQuantity : null,
    pendingOperationId:
      typeof record.pendingOperationId === 'string' ? record.pendingOperationId : null,
  };
}

const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const INVITE_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface MintedInviteSummary {
  token: string;
  inviteHash: string | null;
}

export function readInviteToken(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('invite');
  if (token === null || !INVITE_TOKEN_PATTERN.test(token)) return null;
  return token;
}

export function readMintedInvite(payload: unknown): MintedInviteSummary | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const token = record.token;
  if (typeof token !== 'string' || !INVITE_TOKEN_PATTERN.test(token)) return null;
  const inviteHash = record.inviteHash;
  return {
    token,
    inviteHash:
      typeof inviteHash === 'string' && INVITE_HASH_PATTERN.test(inviteHash)
        ? inviteHash
        : null,
  };
}

export async function inviteTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function parseCompanySummary(payload: unknown): CompanySummary | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const company = record.company;
  if (!company || typeof company !== 'object' || Array.isArray(company)) return null;
  const companyRecord = company as Record<string, unknown>;
  const companyId = companyRecord.id;
  const name = companyRecord.name;
  if (typeof companyId !== 'string' || typeof name !== 'string') return null;

  const role = companyRecord.role;
  if (!isRole(role)) return null;

  let subscription: CompanySubscriptionSummary | null = null;
  if (record.subscription !== null && record.subscription !== undefined) {
    subscription = toSubscription(record.subscription);
    if (subscription === null) return null;
  }
  const capacity = subscription
    ? Math.min(subscription.quantity, subscription.pendingQuantity ?? subscription.quantity)
    : 1;
  const pendingSeats =
    subscription &&
    subscription.pendingQuantity !== null &&
    subscription.pendingOperationId !== null
      ? { quantity: subscription.pendingQuantity, operationId: subscription.pendingOperationId }
      : null;

  const membersPayload = Array.isArray(record.members) ? record.members : [];
  const members = membersPayload
    .map(toMember)
    .filter((member): member is CompanyMemberSummary => member !== null);

  return {
    companyId,
    name,
    state: companyRecord.state === 'disabled' ? 'disabled' : 'active',
    role,
    capacity,
    pendingSeats,
    members,
  };
}
