import { DurableObject } from 'cloudflare:workers';
import { isValidRoomId } from '../lib/worker/requestGuard';
import { DODatabase } from '../lib/whiteboard/doDatabase';
import type { RoomDatabase } from '../lib/whiteboard/db';
import {
  IdentityInputError,
  MAX_AUTHORIZATION_BATCH,
  applyIdentitySchema,
  createGuestAccount,
  isTutorCapReached,
  listOwnedRooms,
  readAccountAuthorizations,
  recordOwnedRoom,
  removeOwnedRoom,
  ownedRoomExists,
  resolveAccountForSubject,
  readPreferredDisplayName,
  setPreferredDisplayName,
  touchOwnedRoom,
} from '../lib/identity/identityStore';
import {
  SessionUnauthorizedError,
  TutorCapReachedError,
  authorizeGuestSession,
  authorizeSessionForPrincipal,
  clearSessionCookie,
  confirmSession,
  disableAccount,
  enableAccount,
  eraseOwnAccount,
  exportOwnAccountData,
  guestSessionCookie,
  issueGuestSession,
  issueSessionForVerifiedPrincipal,
  logoutSession,
  parseGuestSessionCookie,
  parseSessionCookie,
  purgeExpiredGuestAccounts,
  purgeExpiredSessions,
  revokeAllSessions,
  rotateSession,
  selectActiveSessionHashes,
  sessionAllowsDestructiveAction,
  sessionCookie,
  validateSession,
  listPendingErasures,
  clearErasureTarget,
} from '../lib/identity/sessionStore';
import {
  FREE_MAX_ROOMS,
  PLAN_LIMIT_ERROR,
  PLAN_LIMIT_STATUS,
  canAddOwnedRoom,
} from '../lib/plan/limits';
import { readEntitlementsForAccount, deleteCompanyEntitlement } from '../lib/identity/entitlementWriter';
import {
  CompanyOwnerAssertionError,
  createCompany,
  disableCompany,
  listActiveMembers,
  readActiveMembership,
  readCompany,
  revokeMember,
  transferOwnership,
  type CompanyMemberRecord,
  type CompanyRecord,
} from '../lib/company/membership';
import {
  mintInvite,
  redeemInvite,
  revokeInvite,
  type InviteRole,
} from '../lib/company/invites';
import {
  readCompanySubscription,
  releaseSeatChange,
  reserveSeatChange,
  settleSeatChange,
} from '../lib/company/seats';
import { resolveEffectivePlan } from '../lib/plan/effectivePlan';
import {
  applyEvent,
  sha256Hex,
  type ApplyVerdict,
  type BillingApplyInput,
} from '../lib/billing/apply';
import {
  isValidOperationKind,
  recordUserOperation,
  settleCollectionOperation,
  type OperationKind,
} from '../lib/billing/operations';
import {
  claimCollection,
  type BillingSubjectKind,
  type DesiredCollection,
} from '../lib/identity/entitlementWriter';

const RESOLVE_PATH = '/subjects/resolve';
const ISSUE_SESSION_PATH = '/sessions/issue';
const CURRENT_SESSION_PATH = '/sessions/current';
const AUTHORIZE_SESSION_PATH = '/sessions/authorize';
const AUTHORIZE_GUEST_PATH = '/sessions/authorize-guest';
const CONFIRM_SESSION_PATH = '/sessions/confirm';
const ROTATE_SESSION_PATH = '/sessions/rotate';
const LOGOUT_SESSION_PATH = '/sessions/logout';
const AUTHORIZATIONS_PATH = '/accounts/authorizations';
const EXPORT_ACCOUNT_PATH = '/accounts/export';
const ERASE_ACCOUNT_PATH = '/accounts';
const PENDING_ERASURES_PATH = '/accounts/pending-erasures';
const CLEAR_ERASURE_PATH = '/accounts/clear-erasure';
const ACCOUNT_PROFILE_PATH = '/accounts/profile';
const ACCOUNT_PLAN_PATH = '/accounts/plan';
const ACCOUNT_ROOMS_PATH = '/accounts/rooms';
const ACCOUNT_ROOMS_TOUCH_PATH = '/accounts/rooms/touch';
const ACCOUNT_ROOMS_ARCHIVE_PATH = '/accounts/rooms/archive-state';
const REVOKE_ALL_PATH = '/accounts/revoke-all';
const DISABLE_ACCOUNT_PATH = '/accounts/disable';
const ENABLE_ACCOUNT_PATH = '/accounts/enable';
const GUESTS_ISSUE_PATH = '/guests/issue';
const GUESTS_PURGE_PATH = '/guests/purge';
const BILLING_APPLY_PATH = '/billing/events/apply';
const BILLING_STATUS_PATH = '/billing/events/status';
const BILLING_OPERATIONS_PATH = '/billing/operations';
const BILLING_SETTLE_PATH = '/billing/operations/settle';
const BILLING_RATE_LIMIT_PATH = '/billing/rate-limit';
const BILLING_CUSTOMER_PATH = '/billing/customer';
const COMPANY_PATH = '/companies';
const COMPANY_MEMBERSHIP_PATH = '/companies/membership';
const COMPANY_CUSTOMER_PATH = '/companies/customer';
const COMPANY_INVITES_PATH = '/companies/invites';
const COMPANY_INVITE_REDEEM_PATH = '/companies/invites/redeem';
const COMPANY_SEATS_PATH = '/companies/seats';
const COMPANY_SEAT_SETTLE_PATH = '/companies/seats/settle';
const COMPANY_MEMBER_REVOKE_PATH = '/companies/members/revoke';
const COMPANY_OWNER_PATH = '/companies/owner';
const BILLING_PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const GLOBAL_IDENTITY_OBJECT_NAME = 'global';

export const BILLING_OPERATION_RATE_MAX = 10;
export const BILLING_OPERATION_RATE_WINDOW_MS = 60 * 60 * 1000;

export const COMPANY_CREATE_RATE_MAX = 5;
export const COMPANY_INVITE_RATE_MAX = 20;
export const COMPANY_REDEEM_RATE_MAX = 10;
export const COMPANY_SEAT_RATE_MAX = 5;
export const COMPANY_MEMBER_RATE_MAX = 20;

function applyBillingRateLimitSchema(db: RoomDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS billing_rate_counters (
       subject_id TEXT PRIMARY KEY,
       window_start INTEGER NOT NULL,
       count INTEGER NOT NULL CHECK (count >= 0)
     )`,
  );
}

function takeRateSlot(
  db: RoomDatabase,
  subjectId: string,
  max: number,
  now: number,
): { allowed: boolean; retryAfterMs: number } {
  const row = db
    .prepare(
      `SELECT window_start, count FROM billing_rate_counters WHERE subject_id = ?`,
    )
    .get(subjectId) as { window_start: number; count: number } | undefined;
  if (!row || now - row.window_start >= BILLING_OPERATION_RATE_WINDOW_MS) {
    db.prepare(
      `INSERT INTO billing_rate_counters (subject_id, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(subject_id) DO UPDATE SET
         window_start = excluded.window_start,
         count = excluded.count`,
    ).run(subjectId, now);
    return { allowed: true, retryAfterMs: BILLING_OPERATION_RATE_WINDOW_MS };
  }
  const retryAfterMs = row.window_start + BILLING_OPERATION_RATE_WINDOW_MS - now;
  if (row.count < max) {
    db.prepare(
      `UPDATE billing_rate_counters SET count = count + 1 WHERE subject_id = ?`,
    ).run(subjectId);
    return { allowed: true, retryAfterMs };
  }
  return { allowed: false, retryAfterMs };
}

function takeBillingOperationSlot(
  db: RoomDatabase,
  subjectId: string,
  now: number,
): { allowed: boolean; retryAfterMs: number } {
  return takeRateSlot(db, subjectId, BILLING_OPERATION_RATE_MAX, now);
}

function rateLimitedResponse(retryAfterMs: number): Response {
  return Response.json(
    { error: 'Too many requests', retryAfterMs },
    {
      status: 429,
      headers: noStore({ 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) }),
    },
  );
}

function companyJson(
  company: CompanyRecord,
  role: string,
): Record<string, unknown> {
  return {
    id: company.companyId,
    name: company.name,
    role,
    state: company.state,
    processorCustomerId: company.processorCustomerId,
    invoiceApproved: company.invoiceApproved,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
  };
}

function membershipJson(membership: CompanyMemberRecord): Record<string, unknown> {
  return {
    accountId: membership.accountId,
    role: membership.role,
    state: membership.state,
    createdAt: membership.createdAt,
    revokedAt: membership.revokedAt,
  };
}

/**
 * Internal marker the Worker uses to turn a refused session mint into its
 * paused page. It travels DO -> Worker only and is never copied to a client.
 */
export const IDENTITY_OUTCOME_HEADER = 'X-Identity-Outcome';
export const TUTOR_CAP_REACHED_OUTCOME = 'tutor_cap_reached';

/**
 * Reads the configured tutor cap from the environment. Absent or invalid
 * values return undefined so the store applies TUTOR_ACCOUNT_CAP_DEFAULT.
 */
function configuredTutorAccountCap(env: unknown): number | undefined {
  if (typeof env !== 'object' || env === null) return undefined;
  const raw = (env as { TUTOR_ACCOUNT_CAP?: unknown }).TUTOR_ACCOUNT_CAP;
  if (typeof raw !== 'string') return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Whether one owned room falls outside the effective plan's room quota.
 *
 * The most recently used rooms, newest first, keep the available slots; the
 * rest are the excess SEC-015 archives. Re-evaluating this at the boundary is
 * what makes re-upgrading restore every room: no state is written, so there is
 * nothing to forget to undo. `roomId` breaks ties so the same room is not
 * archived on one read and active on the next.
 */
function isArchivedOwnedRoom(
  ownedRoomIdsNewestFirst: readonly string[],
  maxOwnedRooms: number,
  roomId: string,
): boolean {
  if (ownedRoomIdsNewestFirst.length <= maxOwnedRooms) return false;
  return !ownedRoomIdsNewestFirst.slice(0, maxOwnedRooms).includes(roomId);
}

function effectiveMaxOwnedRooms(db: RoomDatabase, accountId: string): number {
  try {
    return resolveEffectivePlan(
      readEntitlementsForAccount(db, accountId),
      Date.now(),
    ).limits.maxOwnedRooms;
  } catch {
    return FREE_MAX_ROOMS;
  }
}

function isSubjectBody(value: unknown): value is {
  issuer: string;
  subject: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.issuer === 'string' &&
    typeof body.subject === 'string'
  );
}

function isAuthorizationsBody(value: unknown): value is {
  accountIds: string[];
  sessions?: Array<{ accountId: string; sessionHash: string }>;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  if (
    !Object.keys(body).every((key) => key === 'accountIds' || key === 'sessions')
  ) {
    return false;
  }
  if (!Array.isArray(body.accountIds)) return false;
  if (body.accountIds.length > MAX_AUTHORIZATION_BATCH) return false;
  if (
    !body.accountIds.every(
      (id) => typeof id === 'string' && id.length >= 1 && id.length <= 128,
    )
  ) {
    return false;
  }
  if (body.sessions === undefined) return true;
  if (!Array.isArray(body.sessions)) return false;
  if (body.sessions.length > MAX_AUTHORIZATION_BATCH) return false;
  return body.sessions.every((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return false;
    }
    const pair = entry as Record<string, unknown>;
    if (Object.keys(pair).length !== 2) return false;
    return (
      typeof pair.accountId === 'string' &&
      pair.accountId.length >= 1 &&
      pair.accountId.length <= 128 &&
      typeof pair.sessionHash === 'string' &&
      /^[0-9a-f]{64}$/.test(pair.sessionHash)
    );
  });
}

// Actor and reason are mandatory so no authorization change can be made
// without a durable record of who made it and why.
function isAccountBody(value: unknown): value is {
  accountId: string;
  actor: string;
  reason: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 3 &&
    typeof body.actor === 'string' &&
    body.actor.trim().length > 0 &&
    body.actor.length <= 256 &&
    typeof body.reason === 'string' &&
    body.reason.trim().length > 0 &&
    body.reason.length <= 1024 &&
    typeof body.accountId === 'string' &&
    body.accountId.length >= 1 &&
    body.accountId.length <= 128
  );
}

function isProfileBody(value: unknown): value is { displayName: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && typeof body.displayName === 'string';
}

function isOwnedRoomBody(value: unknown): value is {
  roomId: string;
  name?: string | null;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  if (typeof body.roomId !== 'string' || !isValidRoomId(body.roomId)) {
    return false;
  }
  if ('name' in body && body.name !== null && typeof body.name !== 'string') {
    return false;
  }
  return true;
}

function isTouchOwnedRoomBody(value: unknown): value is {
  accountId: string;
  roomId: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.roomId === 'string' &&
    isValidRoomId(body.roomId) &&
    typeof body.accountId === 'string' &&
    body.accountId.length >= 1 &&
    body.accountId.length <= 128
  );
}

function isGuestIssueBody(value: unknown): value is {
  roomId: string;
  displayName: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.roomId === 'string' &&
    isValidRoomId(body.roomId) &&
    typeof body.displayName === 'string' &&
    body.displayName.trim().length > 0 &&
    body.displayName.length <= 100
  );
}

function isGuestPurgeBody(value: unknown): value is {
  roomId: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.roomId === 'string' &&
    isValidRoomId(body.roomId)
  );
}

function isClearErasureBody(value: unknown): value is {
  roomId: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.roomId === 'string' &&
    isValidRoomId(body.roomId)
  );
}

function isAuthorizeGuestBody(value: unknown): value is {
  roomId: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.roomId === 'string' &&
    isValidRoomId(body.roomId)
  );
}

function mediaType(request: Request): string | null {
  return (
    request.headers
      .get('content-type')
      ?.split(';', 1)[0]
      .trim()
      .toLowerCase() ?? null
  );
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: 'Method not allowed' },
    { status: 405, headers: { Allow: allow } },
  );
}

function unauthorized(clearCookie = false): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (clearCookie) headers.set('Set-Cookie', clearSessionCookie());
  return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
}

function noStore(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set('Cache-Control', 'no-store');
  return result;
}

async function readExactJson<T>(
  request: Request,
  guard: (value: unknown) => value is T,
): Promise<{ body: T } | { response: Response }> {
  if (mediaType(request) !== 'application/json') {
    return {
      response: Response.json(
        { error: 'Content-Type must be application/json' },
        { status: 415 },
      ),
    };
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      response: Response.json({ error: 'Invalid JSON body' }, { status: 400 }),
    };
  }
  return guard(body)
    ? { body }
    : { response: Response.json({ error: 'Invalid body' }, { status: 400 }) };
}

/**
 * Billing routes hash the exact body text they received, so they read the raw
 * string and parse it themselves instead of going through readExactJson.
 */
async function readRawJson(
  request: Request,
): Promise<{ raw: string; body: unknown } | { response: Response }> {
  const raw = await request.text();
  if (raw.trim() === '') {
    return { response: Response.json({ error: 'Invalid JSON body' }, { status: 400 }) };
  }
  try {
    return { raw, body: JSON.parse(raw) };
  } catch {
    return { response: Response.json({ error: 'Invalid JSON body' }, { status: 400 }) };
  }
}

function isBillingApplyBody(value: unknown): value is BillingApplyInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const event = body.event as Record<string, unknown> | undefined;
  if (typeof event !== 'object' || event === null) return false;
  const objectsOk =
    body.objects === undefined ||
    body.objects === null ||
    (typeof body.objects === 'object' && !Array.isArray(body.objects));
  return (
    body.signatureVerified === true &&
    typeof body.payloadHash === 'string' &&
    BILLING_PAYLOAD_HASH_PATTERN.test(body.payloadHash) &&
    typeof event.id === 'string' &&
    event.id.length >= 1 &&
    typeof event.type === 'string' &&
    event.type.length >= 1 &&
    typeof event.livemode === 'boolean' &&
    typeof event.created === 'number' &&
    Number.isFinite(event.created) &&
    objectsOk
  );
}

function isBillingOperationsBody(
  value: unknown,
): value is {
  subjectKind: 'account' | 'company';
  subjectId: string;
  operationId: string;
  kind: OperationKind;
  stripeObjectId?: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.subjectKind !== 'account' && body.subjectKind !== 'company') return false;
  return (
    typeof body.subjectId === 'string' &&
    body.subjectId.length >= 1 &&
    typeof body.operationId === 'string' &&
    body.operationId.length >= 1 &&
    isValidOperationKind(body.kind) &&
    (body.stripeObjectId === undefined || typeof body.stripeObjectId === 'string')
  );
}

function isCompanyCreateBody(value: unknown): value is { name: string; operationId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.name === 'string' &&
    body.name.trim().length >= 1 &&
    body.name.length <= 100 &&
    typeof body.operationId === 'string' &&
    OPERATION_ID_PATTERN.test(body.operationId)
  );
}

function isCompanyCustomerBody(value: unknown): value is {
  companyId: string;
  operationId: string;
  processorCustomerId: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 3 &&
    typeof body.companyId === 'string' &&
    body.companyId.length >= 1 &&
    body.companyId.length <= 128 &&
    typeof body.operationId === 'string' &&
    OPERATION_ID_PATTERN.test(body.operationId) &&
    typeof body.processorCustomerId === 'string' &&
    /^cus_[A-Za-z0-9_]{1,120}$/.test(body.processorCustomerId)
  );
}

function isCompanyNameBody(value: unknown): value is { name: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.name === 'string' &&
    body.name.trim().length >= 1 &&
    body.name.length <= 100
  );
}

function isCompanyInviteBody(value: unknown): value is { role: InviteRole } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    (body.role === 'admin' || body.role === 'member')
  );
}

function isCompanyInviteRevokeBody(
  value: unknown,
): value is { inviteHash: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.inviteHash === 'string' &&
    /^[0-9a-f]{64}$/.test(body.inviteHash)
  );
}

function isCompanyInviteRedeemBody(
  value: unknown,
): value is { token: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.token === 'string' &&
    body.token.length >= 1 &&
    body.token.length <= 512
  );
}

function isCompanySeatBody(value: unknown): value is {
  quantity: number;
  operationId: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.quantity === 'number' &&
    Number.isInteger(body.quantity) &&
    body.quantity >= 1 &&
    body.quantity <= 10_000 &&
    typeof body.operationId === 'string' &&
    OPERATION_ID_PATTERN.test(body.operationId)
  );
}

function isCompanySeatSettleBody(value: unknown): value is {
  operationId: string;
  outcome: 'success' | 'failure' | 'unknown';
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.operationId === 'string' &&
    OPERATION_ID_PATTERN.test(body.operationId) &&
    (body.outcome === 'success' ||
      body.outcome === 'failure' ||
      body.outcome === 'unknown')
  );
}

function isCompanyMemberBody(value: unknown): value is { accountId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.accountId === 'string' &&
    body.accountId.length >= 1 &&
    body.accountId.length <= 128
  );
}

function isBillingSettleBody(
  value: unknown,
): value is {
  subjectKind: 'account' | 'company';
  subjectId: string;
  operationId: string;
  success?: boolean;
  actualCollectionState?: DesiredCollection | null;
  expectedVersion?: number;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.subjectKind !== 'account' && body.subjectKind !== 'company') return false;
  if (typeof body.subjectId !== 'string' || body.subjectId.length === 0) return false;
  if (typeof body.operationId !== 'string' || body.operationId.length === 0) return false;
  if (body.success !== undefined && typeof body.success !== 'boolean') return false;
  if (
    body.actualCollectionState !== undefined &&
    body.actualCollectionState !== null &&
    body.actualCollectionState !== 'active' &&
    body.actualCollectionState !== 'paused' &&
    body.actualCollectionState !== 'canceled'
  ) {
    return false;
  }
  if (body.expectedVersion !== undefined && typeof body.expectedVersion !== 'number') {
    return false;
  }
  return true;
}

function applyVerdictJson(verdict: ApplyVerdict): Record<string, string | undefined> {
  return verdict.outcome === 'ignored'
    ? { outcome: 'ignored', outcomeDetail: verdict.outcomeDetail }
    : { outcome: 'applied' };
}

function billingObjectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function billingObjectId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  const id = billingObjectRecord(value)?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * D-6 handoff: after an apply, names the subject whose ordering row still
 * needs a collection state sent (no in-flight marker, applied behind
 * desired). Best effort — a miss only delays convergence to R-1, and the
 * executor re-checks the claim inside the DO before calling Stripe.
 */
function pendingCollectionSubject(
  db: RoomDatabase,
  objects: unknown,
): { subjectKind: BillingSubjectKind; subjectId: string } | null {
  const record = billingObjectRecord(objects);
  if (record === null) return null;
  const subscription = billingObjectRecord(record.subscription);
  const invoice = billingObjectRecord(record.invoice);
  const dispute = billingObjectRecord(record.dispute);
  const charge = billingObjectRecord(dispute?.charge);

  let subscriptionId = billingObjectId(subscription?.id);
  if (subscriptionId === null && typeof invoice?.subscription === 'string') {
    subscriptionId = invoice.subscription.length > 0 ? invoice.subscription : null;
  }
  if (subscriptionId === null) {
    const customerId =
      billingObjectId(charge?.customer)
      ?? (typeof invoice?.customer === 'string' && invoice.customer.length > 0
        ? invoice.customer
        : null)
      ?? billingObjectId(subscription?.customer);
    if (customerId !== null) {
      const entitlement = db
        .prepare(
          `SELECT processor_subscription_id FROM entitlements
           WHERE processor_customer_id = ?`,
        )
        .get(customerId) as { processor_subscription_id: string | null } | undefined;
      subscriptionId = entitlement?.processor_subscription_id ?? null;
    }
  }
  if (subscriptionId === null) return null;

  const pending = db
    .prepare(
      `SELECT subject_kind, subject_id FROM billing_subscriptions
       WHERE processor_subscription_id = ?
         AND in_flight_version IS NULL AND applied_version < desired_version`,
    )
    .get(subscriptionId) as
    | { subject_kind: BillingSubjectKind; subject_id: string }
    | undefined;
  return pending === undefined
    ? null
    : { subjectKind: pending.subject_kind, subjectId: pending.subject_id };
}

/** Singleton Durable Object containing global account and session authority. */
export class IdentityDO extends DurableObject {
  readonly db: RoomDatabase;
  readonly tutorAccountCap: number | undefined;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.tutorAccountCap = configuredTutorAccountCap(env);
    this.db = new DODatabase(ctx.storage.sql, ctx.storage);
    applyIdentitySchema(this.db);
    applyBillingRateLimitSchema(this.db);
  }

  async fetch(request: Request): Promise<Response> {
    purgeExpiredSessions(this.db);
    purgeExpiredGuestAccounts(this.db);
    const url = new URL(request.url);
    if (url.pathname === RESOLVE_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isSubjectBody);
      if ('response' in parsed) return parsed.response;
      try {
        const resolved = resolveAccountForSubject(this.db, parsed.body, {
          tutorAccountCap: this.tutorAccountCap,
        });
        if (isTutorCapReached(resolved)) {
          return Response.json(
            { error: 'Tutor account cap reached' },
            { status: 403, headers: noStore() },
          );
        }
        return Response.json(resolved, { status: resolved.created ? 201 : 200 });
      } catch (error) {
        if (error instanceof IdentityInputError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    }

    if (url.pathname === ISSUE_SESSION_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isSubjectBody);
      if ('response' in parsed) return parsed.response;
      try {
        const issued = await issueSessionForVerifiedPrincipal(
          this.db,
          parsed.body,
          undefined,
          { tutorAccountCap: this.tutorAccountCap },
        );
        const { token: _token, createdAt: _createdAt, ...publicSession } = issued;
        return Response.json(publicSession, {
          status: 201,
          headers: noStore({ 'Set-Cookie': sessionCookie(issued) }),
        });
      } catch (error) {
        if (error instanceof TutorCapReachedError) {
          return Response.json(
            { error: 'Tutor account cap reached' },
            {
              status: 403,
              headers: noStore({
                [IDENTITY_OUTCOME_HEADER]: TUTOR_CAP_REACHED_OUTCOME,
              }),
            },
          );
        }
        if (
          error instanceof IdentityInputError ||
          error instanceof SessionUnauthorizedError
        ) {
          return unauthorized();
        }
        throw error;
      }
    }

    if (url.pathname === CURRENT_SESSION_PATH) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const current = token
        ? await validateSession(this.db, token)
        : null;
      return current
        ? Response.json(current, { headers: noStore() })
        : unauthorized(true);
    }

    if (url.pathname === AUTHORIZE_SESSION_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isSubjectBody);
      if ('response' in parsed) return parsed.response;
      const token = parseSessionCookie(request.headers.get('cookie'));
      const current = token
        ? await authorizeSessionForPrincipal(this.db, token, parsed.body)
        : null;
      if (!current) return unauthorized(true);
      return Response.json(
        {
          ...current,
          preferredDisplayName: readPreferredDisplayName(this.db, current.accountId),
        },
        { headers: noStore() },
      );
    }

    if (url.pathname === CONFIRM_SESSION_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isSubjectBody);
      if ('response' in parsed) return parsed.response;
      const token = parseSessionCookie(request.headers.get('cookie'));
      const current = token
        ? await authorizeSessionForPrincipal(this.db, token, parsed.body)
        : null;
      if (!current) return unauthorized(true);
      const confirmed = token ? await confirmSession(this.db, token) : null;
      return confirmed
        ? Response.json(confirmed, { headers: noStore() })
        : unauthorized(true);
    }

    if (url.pathname === ROTATE_SESSION_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      if (request.body !== null) {
        return Response.json({ error: 'Invalid body' }, { status: 400 });
      }
      const token = parseSessionCookie(request.headers.get('cookie'));
      const rotated = token
        ? await rotateSession(this.db, token)
        : null;
      if (!rotated) return unauthorized(true);
      const { token: _token, createdAt: _createdAt, ...publicSession } = rotated;
      return Response.json(publicSession, {
        headers: noStore({ 'Set-Cookie': sessionCookie(rotated) }),
      });
    }

    if (url.pathname === LOGOUT_SESSION_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      if (request.body !== null) {
        return Response.json({ error: 'Invalid body' }, { status: 400 });
      }
      const token = parseSessionCookie(request.headers.get('cookie'));
      if (token) await logoutSession(this.db, token);
      return new Response(null, {
        status: 204,
        headers: noStore({ 'Set-Cookie': clearSessionCookie() }),
      });
    }

    if (url.pathname === ACCOUNT_PROFILE_PATH) {
      if (request.method !== 'PATCH') return methodNotAllowed('PATCH');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const parsed = await readExactJson(request, isProfileBody);
      if ('response' in parsed) return parsed.response;
      try {
        const displayName = setPreferredDisplayName(
          this.db,
          session.accountId,
          parsed.body.displayName,
        );
        return Response.json({ displayName }, { headers: noStore() });
      } catch (error) {
        if (error instanceof IdentityInputError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    }

    if (url.pathname === ACCOUNT_PLAN_PATH) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const accountId = url.searchParams.get('accountId');
      if (accountId === null || accountId.length < 1 || accountId.length > 128) {
        return Response.json({ error: 'Invalid accountId' }, { status: 400 });
      }
      const plan = resolveEffectivePlan(
        readEntitlementsForAccount(this.db, accountId),
        Date.now(),
      );
      return Response.json(plan, { headers: noStore() });
    }

    if (url.pathname === EXPORT_ACCOUNT_PATH) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const exported = token
        ? await exportOwnAccountData(this.db, token)
        : null;
      return exported
        ? Response.json(exported, { headers: noStore() })
        : unauthorized(true);
    }

    if (url.pathname === ERASE_ACCOUNT_PATH) {
      if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      if (!sessionAllowsDestructiveAction(session)) {
        return Response.json(
          { error: 'Reauthentication required' },
          { status: 403, headers: noStore() },
        );
      }
      const roomIds = listOwnedRooms(this.db, session.accountId).map((room) => room.roomId);
      const erased = token ? await eraseOwnAccount(this.db, token) : null;
      if (!erased) return unauthorized(true);
      return Response.json(
        { ok: true, roomIds },
        { headers: noStore({ 'Set-Cookie': clearSessionCookie() }) },
      );
    }

    if (url.pathname === PENDING_ERASURES_PATH) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const roomIds = listPendingErasures(this.db, session.accountId);
      return Response.json({ roomIds }, { headers: noStore() });
    }

    if (url.pathname === CLEAR_ERASURE_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const parsed = await readExactJson(request, isClearErasureBody);
      if ('response' in parsed) return parsed.response;
      clearErasureTarget(this.db, session.accountId, parsed.body.roomId);
      return Response.json({ ok: true }, { headers: noStore() });
    }

    /*
     * Internal: the room object moves the owner's "last used" stamp after a
     * board edit. Board edits travel as Yjs updates to the room object and
     * never pass through the Worker's public API, so the room is the only
     * caller. It advances only a row that already exists -- an active
     * non-owner cannot add the room to their list through it.
     */
    if (url.pathname === ACCOUNT_ROOMS_TOUCH_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isTouchOwnedRoomBody);
      if ('response' in parsed) return parsed.response;
      const touched = touchOwnedRoom(
        this.db,
        parsed.body.accountId,
        parsed.body.roomId,
        Date.now(),
      );
      return Response.json({ ok: true, touched }, { headers: noStore() });
    }

    /*
     * Internal: the room object asks whether this room is over its owner's
     * effective room quota, so an archived room can refuse writes and new
     * admissions while staying readable. Same trust model as the touch route
     * above: only the room object calls it, and it returns a single boolean.
     */
    if (url.pathname === ACCOUNT_ROOMS_ARCHIVE_PATH) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const accountId = url.searchParams.get('accountId');
      const roomId = url.searchParams.get('roomId');
      if (
        accountId === null
        || accountId.length < 1
        || accountId.length > 128
        || roomId === null
        || !isValidRoomId(roomId)
      ) {
        return Response.json({ error: 'Invalid request' }, { status: 400 });
      }
      const plan = resolveEffectivePlan(
        readEntitlementsForAccount(this.db, accountId),
        Date.now(),
      );
      const archived = isArchivedOwnedRoom(
        listOwnedRooms(this.db, accountId)
          .sort((left, right) =>
            right.updatedAt - left.updatedAt
            || (left.roomId < right.roomId ? -1 : left.roomId > right.roomId ? 1 : 0),
          )
          .map((room) => room.roomId),
        plan.limits.maxOwnedRooms,
        roomId,
      );
      return Response.json({ archived }, { headers: noStore() });
    }

    if (url.pathname === ACCOUNT_ROOMS_PATH) {
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);

      if (request.method === 'GET') {
        return Response.json(
          { rooms: listOwnedRooms(this.db, session.accountId) },
          { headers: noStore() },
        );
      }

      if (request.method === 'POST') {
        const parsed = await readExactJson(request, isOwnedRoomBody);
        if ('response' in parsed) return parsed.response;
        try {
          if (
            !canAddOwnedRoom(
              listOwnedRooms(this.db, session.accountId).length,
              ownedRoomExists(this.db, session.accountId, parsed.body.roomId),
              effectiveMaxOwnedRooms(this.db, session.accountId),
            )
          ) {
            return Response.json(
              { error: PLAN_LIMIT_ERROR },
              { status: PLAN_LIMIT_STATUS, headers: noStore() },
            );
          }
          const room = recordOwnedRoom(this.db, {
            accountId: session.accountId,
            roomId: parsed.body.roomId,
            name: parsed.body.name,
            now: Date.now(),
          });
          return Response.json(room, { headers: noStore() });
        } catch (error) {
          if (error instanceof IdentityInputError) {
            return Response.json({ error: error.message }, { status: 400 });
          }
          throw error;
        }
      }

      if (request.method === 'DELETE') {
        const parsed = await readExactJson(request, isOwnedRoomBody);
        if ('response' in parsed) return parsed.response;
        removeOwnedRoom(this.db, session.accountId, parsed.body.roomId);
        return new Response(null, { status: 204, headers: noStore() });
      }

      return methodNotAllowed('GET, POST, DELETE');
    }

    // Lets a room re-check the accounts behind its already-open sockets.
    // Read-only, and it never accepts or returns a session token.
    if (url.pathname === AUTHORIZATIONS_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isAuthorizationsBody);
      if ('response' in parsed) return parsed.response;
      const statuses = readAccountAuthorizations(this.db, parsed.body.accountIds);
      const body: {
        accounts: Record<string, { state: string; authorizationEpoch: number }>;
        activeSessionHashes?: string[];
      } = { accounts: Object.fromEntries(statuses) };
      if (parsed.body.sessions !== undefined) {
        body.activeSessionHashes = selectActiveSessionHashes(
          this.db,
          parsed.body.sessions,
        );
      }
      return Response.json(body, { headers: noStore() });
    }

    const accountOperation =
      url.pathname === REVOKE_ALL_PATH
        ? revokeAllSessions
        : url.pathname === DISABLE_ACCOUNT_PATH
          ? disableAccount
          : url.pathname === ENABLE_ACCOUNT_PATH
            ? enableAccount
            : null;
    if (accountOperation) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isAccountBody);
      if ('response' in parsed) return parsed.response;
      const result = accountOperation(this.db, parsed.body.accountId, {
        actor: parsed.body.actor,
        reason: parsed.body.reason,
      });
      return result
        ? Response.json(result)
        : Response.json({ error: 'Not found' }, { status: 404 });
    }

    if (url.pathname === GUESTS_ISSUE_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isGuestIssueBody);
      if ('response' in parsed) return parsed.response;
      try {
        const now = Date.now();
        const account = createGuestAccount(this.db, {
          roomId: parsed.body.roomId,
          now,
        });
        const issued = await issueGuestSession(this.db, {
          accountId: account.accountId,
          roomId: parsed.body.roomId,
          now,
        });
        const { token: _token, createdAt: _createdAt, ...publicSession } = issued;
        return Response.json(publicSession, {
          status: 201,
          headers: noStore({ 'Set-Cookie': guestSessionCookie(issued) }),
        });
      } catch (error) {
        if (
          error instanceof IdentityInputError ||
          error instanceof SessionUnauthorizedError
        ) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    }

    if (url.pathname === AUTHORIZE_GUEST_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isAuthorizeGuestBody);
      if ('response' in parsed) return parsed.response;
      const token = parseGuestSessionCookie(request.headers.get('cookie'));
      const session = token
        ? await authorizeGuestSession(this.db, token, parsed.body.roomId)
        : null;
      if (!session) return unauthorized();
      return Response.json(session, { headers: noStore() });
    }

    if (url.pathname === GUESTS_PURGE_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isGuestPurgeBody);
      if ('response' in parsed) return parsed.response;
      try {
        const deleted = this.db
          .prepare(
            `DELETE FROM accounts
             WHERE guest_room_id = ? AND provenance = 'guest'`,
          )
          .run(parsed.body.roomId).changes;
        return Response.json({ ok: true, deleted }, { headers: noStore() });
      } catch (error) {
        if (error instanceof IdentityInputError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    }

    if (url.pathname === BILLING_APPLY_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readRawJson(request);
      if ('response' in parsed) return parsed.response;
      if (!isBillingApplyBody(parsed.body)) {
        return Response.json({ error: 'Invalid body' }, { status: 400 });
      }
      const applyInput = parsed.body;
      try {
        const verdict = this.db.transaction(() => applyEvent(this.db, applyInput))();
        const collection = verdict.outcome === 'applied'
          ? pendingCollectionSubject(this.db, applyInput.objects)
          : null;
        return Response.json(
          { ...applyVerdictJson(verdict), ...(collection ? { collection } : {}) },
          {
            status: 200,
            headers: noStore(),
          },
        );
      } catch (error) {
        console.error(
          '[billing:apply]',
          JSON.stringify({
            eventId: applyInput.event.id,
            type: applyInput.event.type,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return Response.json({ error: 'apply_failed' }, { status: 500, headers: noStore() });
      }
    }

    if (url.pathname === BILLING_STATUS_PATH) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const id = url.searchParams.get('id');
      if (!id) return Response.json({ error: 'Invalid body' }, { status: 400 });
      const row = this.db
        .prepare(
          `SELECT outcome, outcome_detail, event_created, applied_at
           FROM billing_events WHERE event_id = ?`,
        )
        .get(id) as
        | {
            outcome: string;
            outcome_detail: string | null;
            event_created: number;
            applied_at: number;
          }
        | undefined;
      if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json(
        {
          outcome: row.outcome,
          outcomeDetail: row.outcome_detail,
          eventCreated: row.event_created,
          appliedAt: row.applied_at,
        },
        { headers: noStore() },
      );
    }

    if (url.pathname === BILLING_OPERATIONS_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readRawJson(request);
      if ('response' in parsed) return parsed.response;
      if (!isBillingOperationsBody(parsed.body)) {
        return Response.json({ error: 'Invalid body' }, { status: 400 });
      }
      const operationsInput = parsed.body;
      const requestHash = await sha256Hex(parsed.raw);
      const now = Date.now();
      try {
        const { recorded, claim } = this.db.transaction(() => {
          const recorded = recordUserOperation(this.db, operationsInput, { requestHash, now });
          if (recorded.status !== 'created' || operationsInput.kind !== 'subscription-collection') {
            return { recorded, claim: null };
          }
          const row = this.db
            .prepare(
              `SELECT processor_subscription_id FROM billing_subscriptions
               WHERE subject_kind = ? AND subject_id = ?
               ORDER BY updated_at DESC, processor_subscription_id ASC
               LIMIT 1`,
            )
            .get(operationsInput.subjectKind, operationsInput.subjectId) as
            | { processor_subscription_id: string }
            | undefined;
          const claim = row
            ? {
                ...claimCollection(this.db, {
                  processorSubscriptionId: row.processor_subscription_id,
                  now,
                }),
                processorSubscriptionId: row.processor_subscription_id,
              }
            : { claimed: false, inFlightVersion: null, inFlightState: null, processorSubscriptionId: null };
          return { recorded, claim };
        })();
        if (recorded.status === 'conflict') {
          return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
        }
        return Response.json(
          {
            status: recorded.record?.status,
            ...(claim ? { claim } : {}),
          },
          {
            status: recorded.status === 'created' ? 201 : 200,
            headers: noStore(),
          },
        );
      } catch (error) {
        console.error(
          '[billing:operations]',
          JSON.stringify({
            subjectKind: parsed.body.subjectKind,
            subjectId: parsed.body.subjectId,
            operationId: parsed.body.operationId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return Response.json({ error: 'operation_failed' }, { status: 500, headers: noStore() });
      }
    }

    if (url.pathname === BILLING_SETTLE_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readRawJson(request);
      if ('response' in parsed) return parsed.response;
      if (!isBillingSettleBody(parsed.body)) {
        return Response.json({ error: 'Invalid body' }, { status: 400 });
      }
      const settleInput = parsed.body;
      const requestHash = await sha256Hex(parsed.raw);
      const now = Date.now();
      try {
        const outcome = this.db.transaction(() =>
          settleCollectionOperation(this.db, settleInput, { requestHash, now }),
        )();
        return Response.json(outcome, { status: 200, headers: noStore() });
      } catch (error) {
        console.error(
          '[billing:settle]',
          JSON.stringify({
            subjectKind: parsed.body.subjectKind,
            subjectId: parsed.body.subjectId,
            operationId: parsed.body.operationId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return Response.json({ error: 'settle_failed' }, { status: 500, headers: noStore() });
      }
    }

    if (url.pathname === BILLING_RATE_LIMIT_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      if (request.body !== null) {
        return Response.json({ error: 'Invalid body' }, { status: 400 });
      }
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const outcome = takeBillingOperationSlot(this.db, session.accountId, Date.now());
      return Response.json(outcome, { headers: noStore() });
    }

    if (url.pathname === BILLING_CUSTOMER_PATH) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const personal = readEntitlementsForAccount(this.db, session.accountId)
        .find((row) => row.source === 'personal');
      return Response.json(
        { processorCustomerId: personal?.processorCustomerId ?? null },
        { headers: noStore() },
      );
    }

    if (url.pathname === COMPANY_MEMBERSHIP_PATH) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const membership = readActiveMembership(this.db, session.accountId);
      const company = membership
        ? readCompany(this.db, membership.companyId)
        : null;
      if (!membership || !company || company.state !== 'active') {
        return Response.json({ company: null }, { headers: noStore() });
      }
      return Response.json(
        {
          company: {
            id: company.companyId,
            name: company.name,
            role: membership.role,
          },
        },
        { headers: noStore() },
      );
    }

    if (url.pathname === COMPANY_PATH) {
      if (request.method === 'GET') {
        const token = parseSessionCookie(request.headers.get('cookie'));
        const session = token ? await validateSession(this.db, token) : null;
        if (!session) return unauthorized(true);
        const membership = readActiveMembership(this.db, session.accountId);
        const company = membership
          ? readCompany(this.db, membership.companyId)
          : null;
        if (!membership || !company || company.state !== 'active') {
          return Response.json(
            { company: null, members: [], subscription: null },
            { headers: noStore() },
          );
        }
        const subscription = readCompanySubscription(this.db, membership.companyId);
        return Response.json(
          {
            company: companyJson(company, membership.role),
            members: listActiveMembers(this.db, membership.companyId).map(
              membershipJson,
            ),
            subscription: subscription
              ? {
                  quantity: subscription.quantity,
                  pendingQuantity: subscription.pendingQuantity,
                  status: subscription.status,
                  collectionMethod: subscription.collectionMethod,
                  currentPeriodEnd: subscription.currentPeriodEnd,
                  firstPaidAt: subscription.firstPaidAt,
                }
              : null,
          },
          { headers: noStore() },
        );
      }

      if (request.method === 'PATCH') {
        const token = parseSessionCookie(request.headers.get('cookie'));
        const session = token ? await validateSession(this.db, token) : null;
        if (!session) return unauthorized(true);
        const membership = readActiveMembership(this.db, session.accountId);
        if (!membership) {
          return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
        }
        if (membership.role === 'member') {
          return Response.json({ error: 'Forbidden' }, { status: 403, headers: noStore() });
        }
        const parsed = await readExactJson(request, isCompanyNameBody);
        if ('response' in parsed) return parsed.response;
        const now = Date.now();
        this.db
          .prepare(
            `UPDATE companies SET name = ?, updated_at = ? WHERE company_id = ?`,
          )
          .run(parsed.body.name.trim(), now, membership.companyId);
        const company = readCompany(this.db, membership.companyId);
        if (!company) {
          return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
        }
        return Response.json(
          { company: companyJson(company, membership.role) },
          { headers: noStore() },
        );
      }

      if (request.method === 'DELETE') {
        const token = parseSessionCookie(request.headers.get('cookie'));
        const session = token ? await validateSession(this.db, token) : null;
        if (!session) return unauthorized(true);
        const membership = readActiveMembership(this.db, session.accountId);
        if (!membership) {
          return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
        }
        const now = Date.now();
        let outcome: ReturnType<typeof disableCompany>;
        try {
          outcome = this.db.transaction(() => {
            const result = disableCompany(this.db, {
              companyId: membership.companyId,
              actorAccountId: session.accountId,
              now,
            });
            if (result.outcome === 'disabled') {
              for (const accountId of result.revokedAccountIds) {
                deleteCompanyEntitlement(this.db, {
                  companyId: membership.companyId,
                  accountId,
                  cause: {
                    kind: 'membership',
                    id: crypto.randomUUID(),
                    actor: session.accountId,
                    reason: 'company disabled',
                  },
                  now,
                });
              }
            }
            return result;
          })();
        } catch (error) {
          if (error instanceof CompanyOwnerAssertionError) {
            return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
          }
          throw error;
        }
        if (outcome.outcome === 'disabled') {
          return Response.json(
            { outcome: 'disabled', revokedAccountIds: outcome.revokedAccountIds },
            { headers: noStore() },
          );
        }
        if (outcome.outcome === 'forbidden') {
          return Response.json({ error: 'Forbidden' }, { status: 403, headers: noStore() });
        }
        return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
      }

      if (request.method !== 'POST') return methodNotAllowed('GET, POST, PATCH, DELETE');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const parsed = await readRawJson(request);
      if ('response' in parsed) return parsed.response;
      if (!isCompanyCreateBody(parsed.body)) {
        return Response.json({ error: 'Invalid body' }, { status: 400 });
      }
      const createBody = parsed.body;
      const requestHash = await sha256Hex(parsed.raw);
      const now = Date.now();
      const limit = takeRateSlot(
        this.db,
        `company:create:${session.accountId}`,
        COMPANY_CREATE_RATE_MAX,
        now,
      );
      if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);

      type CreateOutcome =
        | { conflict: true }
        | {
            conflict?: undefined;
            status: number;
            company: CompanyRecord;
            membership: CompanyMemberRecord;
            operation: { id: string; status: string };
          };
      let outcome: CreateOutcome;
      try {
        outcome = this.db.transaction((): CreateOutcome => {
          const existing = readActiveMembership(this.db, session.accountId);
          if (existing) {
            const record = this.db
              .prepare(
                `SELECT status, request_hash FROM billing_operations
                 WHERE subject_kind = 'company' AND subject_id = ?
                   AND operation_id = ? AND kind = 'company-create'`,
              )
              .get(existing.companyId, createBody.operationId) as
              | { status: string; request_hash: string }
              | undefined;
            const company = readCompany(this.db, existing.companyId);
            if (record && record.request_hash === requestHash && company) {
              return {
                status: 200,
                company,
                membership: existing,
                operation: { id: createBody.operationId, status: record.status },
              };
            }
            return { conflict: true };
          }

          const created = createCompany(this.db, {
            name: createBody.name.trim(),
            ownerAccountId: session.accountId,
            now,
          });
          if (created.outcome !== 'created') return { conflict: true };
          const operation = recordUserOperation(
            this.db,
            {
              subjectKind: 'company',
              subjectId: created.company.companyId,
              operationId: createBody.operationId,
              kind: 'company-create',
            },
            { requestHash, now },
          );
          return {
            status: 201,
            company: created.company,
            membership: created.membership,
            operation: {
              id: createBody.operationId,
              status: operation.record?.status ?? 'pending',
            },
          };
        })();
      } catch (error) {
        if (error instanceof CompanyOwnerAssertionError) {
          return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
        }
        throw error;
      }

      if (outcome.conflict) {
        return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
      }
      return Response.json(
        {
          company: companyJson(outcome.company, outcome.membership.role),
          membership: membershipJson(outcome.membership),
          operation: outcome.operation,
        },
        { status: outcome.status, headers: noStore() },
      );
    }

    if (url.pathname === COMPANY_CUSTOMER_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const parsed = await readExactJson(request, isCompanyCustomerBody);
      if ('response' in parsed) return parsed.response;
      const membership = readActiveMembership(this.db, session.accountId);
      if (
        !membership ||
        membership.companyId !== parsed.body.companyId ||
        membership.role !== 'owner'
      ) {
        return Response.json({ error: 'Forbidden' }, { status: 403, headers: noStore() });
      }
      const now = Date.now();
      const outcome = this.db.transaction(() => {
        const operation = this.db
          .prepare(
            `SELECT status FROM billing_operations
             WHERE subject_kind = 'company' AND subject_id = ?
               AND operation_id = ? AND kind = 'company-create'`,
          )
          .get(parsed.body.companyId, parsed.body.operationId) as
          | { status: string }
          | undefined;
        if (!operation) return null;
        this.db
          .prepare(
            `UPDATE companies SET processor_customer_id = ?, updated_at = ?
             WHERE company_id = ?`,
          )
          .run(parsed.body.processorCustomerId, now, parsed.body.companyId);
        this.db
          .prepare(
            `UPDATE billing_operations
             SET status = 'succeeded', stripe_object_id = ?, updated_at = ?
             WHERE subject_kind = 'company' AND subject_id = ?
               AND operation_id = ? AND kind = 'company-create'`,
          )
          .run(parsed.body.processorCustomerId, now, parsed.body.companyId, parsed.body.operationId);
        return readCompany(this.db, parsed.body.companyId);
      })();
      if (!outcome) {
        return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
      }
      return Response.json(
        {
          company: companyJson(outcome, membership.role),
          membership: membershipJson(membership),
          operation: { id: parsed.body.operationId, status: 'succeeded' },
        },
        { headers: noStore() },
      );
    }

    if (url.pathname === COMPANY_INVITES_PATH) {
      if (request.method !== 'POST' && request.method !== 'DELETE') {
        return methodNotAllowed('POST, DELETE');
      }
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const membership = readActiveMembership(this.db, session.accountId);
      if (!membership || membership.state !== 'active') {
        return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
      }
      const now = Date.now();
      const limit = takeRateSlot(
        this.db,
        `company:invites:${membership.companyId}`,
        COMPANY_INVITE_RATE_MAX,
        now,
      );
      if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);

      if (request.method === 'POST') {
        const parsed = await readExactJson(request, isCompanyInviteBody);
        if ('response' in parsed) return parsed.response;
        const outcome = await mintInvite(this.db, {
          companyId: membership.companyId,
          role: parsed.body.role,
          createdBy: session.accountId,
          now,
        });
        if (outcome.outcome === 'forbidden') {
          return Response.json({ error: 'Forbidden' }, { status: 403, headers: noStore() });
        }
        return Response.json(outcome.invite, { status: 201, headers: noStore() });
      }

      const parsed = await readExactJson(request, isCompanyInviteRevokeBody);
      if ('response' in parsed) return parsed.response;
      const outcome = revokeInvite(this.db, {
        companyId: membership.companyId,
        inviteHash: parsed.body.inviteHash,
        actorAccountId: session.accountId,
        now,
      });
      if (outcome.outcome === 'revoked') {
        return Response.json({ outcome: 'revoked' }, { headers: noStore() });
      }
      if (outcome.outcome === 'forbidden') {
        return Response.json({ error: 'Forbidden' }, { status: 403, headers: noStore() });
      }
      if (outcome.outcome === 'not_found') {
        return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
      }
      return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
    }

    if (url.pathname === COMPANY_INVITE_REDEEM_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const now = Date.now();
      const limit = takeRateSlot(
        this.db,
        `company:redeem:${session.accountId}`,
        COMPANY_REDEEM_RATE_MAX,
        now,
      );
      if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);
      const parsed = await readExactJson(request, isCompanyInviteRedeemBody);
      if ('response' in parsed) return parsed.response;
      const outcome = await redeemInvite(this.db, {
        token: parsed.body.token,
        accountId: session.accountId,
        now,
      });
      if (outcome.outcome === 'redeemed') {
        return Response.json(
          { companyId: outcome.companyId, role: outcome.role },
          { headers: noStore() },
        );
      }
      if (outcome.outcome === 'no_capacity') {
        return Response.json(
          { error: PLAN_LIMIT_ERROR },
          { status: PLAN_LIMIT_STATUS, headers: noStore() },
        );
      }
      if (outcome.outcome === 'already_member') {
        return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
      }
      return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
    }

    if (url.pathname === COMPANY_SEATS_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const membership = readActiveMembership(this.db, session.accountId);
      if (!membership) {
        return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
      }
      const parsed = await readRawJson(request);
      if ('response' in parsed) return parsed.response;
      if (!isCompanySeatBody(parsed.body)) {
        return Response.json({ error: 'Invalid body' }, { status: 400 });
      }
      const now = Date.now();
      const limit = takeRateSlot(
        this.db,
        `company:seats:${membership.companyId}`,
        COMPANY_SEAT_RATE_MAX,
        now,
      );
      if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);
      const requestHash = await sha256Hex(parsed.raw);
      const outcome = reserveSeatChange(this.db, {
        companyId: membership.companyId,
        actorAccountId: session.accountId,
        targetQuantity: parsed.body.quantity,
        operationId: parsed.body.operationId,
        requestHash,
        now,
      });
      if (outcome.outcome === 'reserved') {
        const subscription = readCompanySubscription(this.db, membership.companyId);
        if (!subscription) {
          return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
        }
        return Response.json(
          {
            status: 'reserved',
            companyId: membership.companyId,
            operationId: outcome.operationId,
            targetQuantity: outcome.targetQuantity,
            direction: outcome.direction,
            prorationBehavior: outcome.prorationBehavior,
            processorSubscriptionId: subscription.processorSubscriptionId,
          },
          { headers: noStore() },
        );
      }
      if (outcome.outcome === 'forbidden') {
        return Response.json({ error: 'Forbidden' }, { status: 403, headers: noStore() });
      }
      return Response.json(
        { error: 'Conflict', reason: outcome.outcome },
        { status: 409, headers: noStore() },
      );
    }

    if (url.pathname === COMPANY_SEAT_SETTLE_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const membership = readActiveMembership(this.db, session.accountId);
      if (!membership) {
        return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
      }
      const parsed = await readExactJson(request, isCompanySeatSettleBody);
      if ('response' in parsed) return parsed.response;
      const now = Date.now();
      if (parsed.body.outcome === 'unknown') {
        return Response.json({ status: 'pending' }, { headers: noStore() });
      }
      if (parsed.body.outcome === 'success') {
        const result = settleSeatChange(this.db, {
          companyId: membership.companyId,
          operationId: parsed.body.operationId,
          now,
        });
        if (!result.settled) {
          return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
        }
        return Response.json({ status: 'settled' }, { headers: noStore() });
      }
      const released = releaseSeatChange(this.db, {
        companyId: membership.companyId,
        operationId: parsed.body.operationId,
        now,
      });
      if (!released.released) {
        return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
      }
      return Response.json({ status: 'released' }, { headers: noStore() });
    }

    if (url.pathname === COMPANY_MEMBER_REVOKE_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const membership = readActiveMembership(this.db, session.accountId);
      if (!membership) {
        return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
      }
      const limited = takeRateSlot(
        this.db,
        `company:members:${membership.companyId}`,
        COMPANY_MEMBER_RATE_MAX,
        Date.now(),
      );
      if (!limited.allowed) return rateLimitedResponse(limited.retryAfterMs);
      const parsed = await readExactJson(request, isCompanyMemberBody);
      if ('response' in parsed) return parsed.response;
      const now = Date.now();
      const outcome = this.db.transaction(() => {
        const result = revokeMember(this.db, {
          companyId: membership.companyId,
          accountId: parsed.body.accountId,
          actorAccountId: session.accountId,
          now,
        });
        if (result.outcome === 'revoked') {
          deleteCompanyEntitlement(this.db, {
            companyId: membership.companyId,
            accountId: result.accountId,
            cause: {
              kind: 'membership',
              id: crypto.randomUUID(),
              actor: session.accountId,
              reason: 'company member revoked',
            },
            now,
          });
        }
        return result;
      })();
      if (outcome.outcome === 'revoked') {
        return Response.json(
          { outcome: 'revoked', accountId: outcome.accountId },
          { headers: noStore() },
        );
      }
      if (outcome.outcome === 'forbidden') {
        return Response.json({ error: 'Forbidden' }, { status: 403, headers: noStore() });
      }
      if (outcome.outcome === 'owner') {
        return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
      }
      return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
    }

    if (url.pathname === COMPANY_OWNER_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      const membership = readActiveMembership(this.db, session.accountId);
      if (!membership) {
        return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
      }
      const limited = takeRateSlot(
        this.db,
        `company:members:${membership.companyId}`,
        COMPANY_MEMBER_RATE_MAX,
        Date.now(),
      );
      if (!limited.allowed) return rateLimitedResponse(limited.retryAfterMs);
      const parsed = await readExactJson(request, isCompanyMemberBody);
      if ('response' in parsed) return parsed.response;
      const now = Date.now();
      let outcome: ReturnType<typeof transferOwnership>;
      try {
        outcome = this.db.transaction(() =>
          transferOwnership(this.db, {
            companyId: membership.companyId,
            actorAccountId: session.accountId,
            targetAccountId: parsed.body.accountId,
            now,
          }),
        )();
      } catch (error) {
        if (error instanceof CompanyOwnerAssertionError) {
          return Response.json({ error: 'Conflict' }, { status: 409, headers: noStore() });
        }
        throw error;
      }
      if (outcome.outcome === 'transferred') {
        return Response.json(
          { outcome: 'transferred', accountId: outcome.accountId },
          { headers: noStore() },
        );
      }
      if (outcome.outcome === 'forbidden') {
        return Response.json({ error: 'Forbidden' }, { status: 403, headers: noStore() });
      }
      return Response.json({ error: 'Not found' }, { status: 404, headers: noStore() });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
}

/** Returns the one global identity authority; callers do not choose its name. */
export function getIdentityObject(
  namespace: DurableObjectNamespace<IdentityDO>,
): DurableObjectStub<IdentityDO> {
  return namespace.get(namespace.idFromName(GLOBAL_IDENTITY_OBJECT_NAME));
}
