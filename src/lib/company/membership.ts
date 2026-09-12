import type { RoomDatabase } from '../whiteboard/db';
import { cancelCollection } from '../identity/entitlementWriter';

export type CompanyRole = 'owner' | 'admin' | 'member';
export type CompanyMemberState = 'active' | 'revoked';
export type CompanyState = 'active' | 'disabled';

export class CompanyOwnerAssertionError extends Error {
  constructor(companyId: string) {
    super(`company ${companyId} must have exactly one active owner`);
    this.name = 'CompanyOwnerAssertionError';
  }
}

export interface CompanyRecord {
  companyId: string;
  processorCustomerId: string | null;
  name: string;
  state: CompanyState;
  invoiceApproved: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyMemberRecord {
  companyId: string;
  accountId: string;
  role: CompanyRole;
  state: CompanyMemberState;
  createdAt: number;
  revokedAt: number | null;
}

export type CreateCompanyOutcome =
  | { outcome: 'created'; company: CompanyRecord; membership: CompanyMemberRecord }
  | { outcome: 'membership_conflict' };

interface CompanyDbRow {
  company_id: string;
  processor_customer_id: string | null;
  name: string;
  state: CompanyState;
  invoice_approved: number;
  created_at: number;
  updated_at: number;
}

interface MemberDbRow {
  company_id: string;
  account_id: string;
  role: CompanyRole;
  state: CompanyMemberState;
  created_at: number;
  revoked_at: number | null;
}

function toCompany(row: CompanyDbRow): CompanyRecord {
  return {
    companyId: row.company_id,
    processorCustomerId: row.processor_customer_id,
    name: row.name,
    state: row.state,
    invoiceApproved: row.invoice_approved === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMember(row: MemberDbRow): CompanyMemberRecord {
  return {
    companyId: row.company_id,
    accountId: row.account_id,
    role: row.role,
    state: row.state,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function readCompany(
  db: RoomDatabase,
  companyId: string,
): CompanyRecord | null {
  const row = db
    .prepare(
      `SELECT company_id, processor_customer_id, name, state, invoice_approved,
              created_at, updated_at
       FROM companies WHERE company_id = ?`,
    )
    .get(companyId) as CompanyDbRow | undefined;
  return row ? toCompany(row) : null;
}

export function readMember(
  db: RoomDatabase,
  companyId: string,
  accountId: string,
): CompanyMemberRecord | null {
  const row = db
    .prepare(
      `SELECT company_id, account_id, role, state, created_at, revoked_at
       FROM company_members WHERE company_id = ? AND account_id = ?`,
    )
    .get(companyId, accountId) as MemberDbRow | undefined;
  return row ? toMember(row) : null;
}

export function readActiveMembership(
  db: RoomDatabase,
  accountId: string,
): CompanyMemberRecord | null {
  const row = db
    .prepare(
      `SELECT company_id, account_id, role, state, created_at, revoked_at
       FROM company_members WHERE account_id = ? AND state = 'active'`,
    )
    .get(accountId) as MemberDbRow | undefined;
  return row ? toMember(row) : null;
}

export function listActiveMembers(
  db: RoomDatabase,
  companyId: string,
): CompanyMemberRecord[] {
  const rows = db
    .prepare(
      `SELECT company_id, account_id, role, state, created_at, revoked_at
       FROM company_members WHERE company_id = ? AND state = 'active'
       ORDER BY created_at ASC, account_id ASC`,
    )
    .all(companyId) as MemberDbRow[];
  return rows.map(toMember);
}

export function assertOneActiveOwner(
  db: RoomDatabase,
  companyId: string,
): void {
  const company = readCompany(db, companyId);
  if (!company || company.state !== 'active') return;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM company_members
       WHERE company_id = ? AND role = 'owner' AND state = 'active'`,
    )
    .get(companyId) as { count: number };
  if (Number(row.count) !== 1) throw new CompanyOwnerAssertionError(companyId);
}

export type RevokeMemberOutcome =
  | { outcome: 'revoked'; accountId: string }
  | { outcome: 'owner' }
  | { outcome: 'not_found' }
  | { outcome: 'forbidden' };

export function revokeMember(
  db: RoomDatabase,
  input: {
    companyId: string;
    accountId: string;
    actorAccountId: string;
    now: number;
  },
): RevokeMemberOutcome {
  return db.transaction((): RevokeMemberOutcome => {
    const company = readCompany(db, input.companyId);
    if (!company || company.state !== 'active') return { outcome: 'not_found' };

    const actor = readMember(db, input.companyId, input.actorAccountId);
    if (!actor || actor.state !== 'active' || actor.role === 'member') {
      return { outcome: 'forbidden' };
    }

    const target = readMember(db, input.companyId, input.accountId);
    if (!target || target.state !== 'active') return { outcome: 'not_found' };
    if (target.role === 'owner') return { outcome: 'owner' };

    db.prepare(
      `UPDATE company_members SET state = 'revoked', revoked_at = ?
       WHERE company_id = ? AND account_id = ? AND state = 'active'`,
    ).run(input.now, input.companyId, input.accountId);
    assertOneActiveOwner(db, input.companyId);
    return { outcome: 'revoked', accountId: input.accountId };
  })();
}

export type TransferOwnershipOutcome =
  | { outcome: 'transferred'; accountId: string }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

export function transferOwnership(
  db: RoomDatabase,
  input: {
    companyId: string;
    actorAccountId: string;
    targetAccountId: string;
    now: number;
  },
): TransferOwnershipOutcome {
  return db.transaction((): TransferOwnershipOutcome => {
    const company = readCompany(db, input.companyId);
    if (!company || company.state !== 'active') return { outcome: 'not_found' };

    const actor = readMember(db, input.companyId, input.actorAccountId);
    if (!actor || actor.state !== 'active' || actor.role !== 'owner') {
      return { outcome: 'forbidden' };
    }

    db.prepare(
      `UPDATE company_members SET role = 'admin'
       WHERE company_id = ? AND account_id = ? AND role = 'owner' AND state = 'active'`,
    ).run(input.companyId, input.actorAccountId);
    db.prepare(
      `UPDATE company_members SET role = 'owner'
       WHERE company_id = ? AND account_id = ? AND state = 'active'`,
    ).run(input.companyId, input.targetAccountId);
    assertOneActiveOwner(db, input.companyId);
    return { outcome: 'transferred', accountId: input.targetAccountId };
  })();
}

export type ErasureTransferOutcome =
  | { outcome: 'transferred'; accountId: string }
  | { outcome: 'sole_member' }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

export function transferOwnershipForErasure(
  db: RoomDatabase,
  input: { companyId: string; erasingAccountId: string; now: number },
): ErasureTransferOutcome {
  return db.transaction((): ErasureTransferOutcome => {
    const company = readCompany(db, input.companyId);
    if (!company || company.state !== 'active') return { outcome: 'not_found' };

    const owner = readMember(db, input.companyId, input.erasingAccountId);
    if (!owner || owner.state !== 'active' || owner.role !== 'owner') {
      return { outcome: 'forbidden' };
    }

    const successor = db
      .prepare(
        `SELECT account_id AS accountId FROM company_members
         WHERE company_id = ? AND state = 'active' AND account_id <> ?
         ORDER BY (role = 'admin') DESC, created_at ASC, account_id ASC
         LIMIT 1`,
      )
      .get(input.companyId, input.erasingAccountId) as
      | { accountId: string }
      | undefined;
    if (!successor) return { outcome: 'sole_member' };

    db.prepare(
      `UPDATE company_members SET role = 'admin'
       WHERE company_id = ? AND account_id = ? AND role = 'owner' AND state = 'active'`,
    ).run(input.companyId, input.erasingAccountId);
    db.prepare(
      `UPDATE company_members SET role = 'owner'
       WHERE company_id = ? AND account_id = ? AND state = 'active'`,
    ).run(input.companyId, successor.accountId);
    assertOneActiveOwner(db, input.companyId);
    return { outcome: 'transferred', accountId: successor.accountId };
  })();
}

export type DisableCompanyOutcome =
  | { outcome: 'disabled'; revokedAccountIds: string[] }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

export function disableCompany(
  db: RoomDatabase,
  input: { companyId: string; actorAccountId: string; now: number },
): DisableCompanyOutcome {
  return db.transaction((): DisableCompanyOutcome => {
    const company = readCompany(db, input.companyId);
    if (!company || company.state !== 'active') return { outcome: 'not_found' };

    const actor = readMember(db, input.companyId, input.actorAccountId);
    if (!actor || actor.state !== 'active' || actor.role !== 'owner') {
      return { outcome: 'forbidden' };
    }

    const revokedAccountIds = listActiveMembers(db, input.companyId).map(
      (member) => member.accountId,
    );
    db.prepare(
      `UPDATE company_members SET state = 'revoked', revoked_at = ?
       WHERE company_id = ? AND state = 'active'`,
    ).run(input.now, input.companyId);
    db.prepare(
      `UPDATE companies SET state = 'disabled', updated_at = ?
       WHERE company_id = ?`,
    ).run(input.now, input.companyId);
    assertOneActiveOwner(db, input.companyId);

    const subscription = db
      .prepare(
        `SELECT processor_subscription_id AS processorSubscriptionId
         FROM company_subscriptions WHERE company_id = ?`,
      )
      .get(input.companyId) as { processorSubscriptionId: string } | undefined;
    if (subscription) {
      cancelCollection(db, {
        processorSubscriptionId: subscription.processorSubscriptionId,
        now: input.now,
      });
    }

    return { outcome: 'disabled', revokedAccountIds };
  })();
}

export function createCompany(
  db: RoomDatabase,
  input: { name: string; ownerAccountId: string; now: number },
): CreateCompanyOutcome {
  return db.transaction((): CreateCompanyOutcome => {
    if (readActiveMembership(db, input.ownerAccountId)) {
      return { outcome: 'membership_conflict' };
    }

    const companyId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO companies (company_id, name, state, invoice_approved, created_at, updated_at)
       VALUES (?, ?, 'active', 0, ?, ?)`,
    ).run(companyId, input.name, input.now, input.now);
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'owner', 'active', ?)`,
    ).run(companyId, input.ownerAccountId, input.now);
    assertOneActiveOwner(db, companyId);

    const company = readCompany(db, companyId);
    const membership = readMember(db, companyId, input.ownerAccountId);
    if (!company || !membership) throw new Error('company bootstrap failed');
    return { outcome: 'created', company, membership };
  })();
}
