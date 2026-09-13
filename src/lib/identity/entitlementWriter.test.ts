import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  IdentityInputError,
  applyIdentitySchema,
  isTutorCapReached,
  resolveAccountForSubject,
} from './identityStore';
import {
  applyCompanySubscriptionState,
  applySubscriptionState,
  attachCompanySubscription,
  cancelCollection,
  claimCollection,
  ensureBillingSubscription,
  pseudonymizeEntitlementAuditSubject,
  readBillingSweep,
  readEntitlementsForAccount,
  recomputeDesiredCollection,
  recordBillingSweep,
  recordGraceExpiryAudit,
  recordOperatorAction,
  releaseCompanySeatChange,
  repairCollectionVersion,
  reserveCompanySeatChange,
  setCompanyFirstPaidAt,
  settleCollectionFailure,
  settleCollectionSuccess,
  settleCompanySeatChange,
  upsertDisputeHold,
  writeEntitlement,
  deleteCompanyEntitlement,
} from './entitlementWriter';
import { PAST_DUE_GRACE_MS } from '../plan/catalog';
import type {
  EntitlementCause,
  EntitlementCauseKind,
  EntitlementState,
  EntitlementWrite,
} from './entitlementWriter';

const CAUSE_KINDS: EntitlementCauseKind[] = [
  'processor_event',
  'membership',
  'seat_operation',
  'reconcile',
  'grace_expiry',
  'operator',
  'erasure',
];

function entitlingState(overrides: Partial<EntitlementState> = {}): EntitlementState {
  return {
    planId: 'tutor_pro_monthly',
    status: 'active',
    graceUntil: null,
    collectionPaused: false,
    companyId: null,
    currentPeriodEnd: 1_800_000_000_000,
    processorCustomerId: 'cus_1',
    processorSubscriptionId: 'sub_1',
    ...overrides,
  };
}

function cause(kind: EntitlementCauseKind, id: string): EntitlementCause {
  return { kind, id, actor: 'test-operator', reason: 'writer test' };
}

function auditRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT audit_id AS auditId, subject_kind AS subjectKind,
              subject_id AS subjectId, action, cause_kind AS causeKind,
              cause_id AS causeId, actor, reason, previous_plan AS previousPlan,
              next_plan AS nextPlan, previous_status AS previousStatus,
              next_status AS nextStatus, processor_event_id AS processorEventId,
              created_at AS createdAt
       FROM entitlement_audit`,
    )
    .all() as Array<Record<string, unknown>>;
}

describe('writer-owned table guard', () => {
  const repositoryRoot = resolve(process.cwd());
  const writerOwnedTables = [
    'entitlements',
    'entitlement_audit',
    'billing_subscriptions',
    'billing_dispute_holds',
    'company_subscriptions',
  ];
  const writeStatement = new RegExp(
    `(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+` +
      `(?:${writerOwnedTables.join('|')})\\b`,
    'i',
  );

  function sourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...sourceFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('only entitlementWriter.ts writes the writer-owned tables', () => {
    const offenders = sourceFiles(join(repositoryRoot, 'src'))
      .map((file) => relative(repositoryRoot, file).split('\\').join('/'))
      .filter((path) => path !== 'src/lib/identity/entitlementWriter.ts')
      .filter((path) => writeStatement.test(readFileSync(resolve(repositoryRoot, path), 'utf8')));

    expect(offenders).toEqual([]);
  });
});

describe('entitlementWriter', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function account(subject: string): string {
    const outcome = resolveAccountForSubject(db, {
      issuer: 'https://issuer',
      subject,
    });
    if (isTutorCapReached(outcome)) {
      throw new Error('unexpected tutor cap outcome');
    }
    return outcome.account.accountId;
  }

  function write(accountId: string, state: EntitlementState): EntitlementWrite {
    return { accountId, source: 'personal', state, now: 1_000 };
  }

  for (const kind of CAUSE_KINDS) {
    it(`writes one audit row for a ${kind} cause and fills processor_event_id only for processor_event`, () => {
      const accountId = account(`writer-${kind}`);

      const result = writeEntitlement(
        db,
        write(accountId, entitlingState()),
        cause(kind, `cause-${kind}`),
      );

      expect(result).toEqual({ changed: true });
      expect(
        db
          .prepare(
            `SELECT plan_id, status, collection_paused, updated_at
             FROM entitlements WHERE account_id = ?`,
          )
          .get(accountId),
      ).toEqual({
        plan_id: 'tutor_pro_monthly',
        status: 'active',
        collection_paused: 0,
        updated_at: 1_000,
      });
      const audits = auditRows(db);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        subjectKind: 'account',
        subjectId: accountId,
        action: 'entitlement_change',
        causeKind: kind,
        causeId: `cause-${kind}`,
        actor: 'test-operator',
        reason: 'writer test',
        previousPlan: null,
        nextPlan: 'tutor_pro_monthly',
        previousStatus: null,
        nextStatus: 'active',
        processorEventId: kind === 'processor_event' ? `cause-${kind}` : null,
        createdAt: 1_000,
      });
    });
  }

  it('records the previous and next plan and status when the state changes', () => {
    const accountId = account('writer-change');
    writeEntitlement(db, write(accountId, entitlingState()), cause('operator', 'op-grant'));
    writeEntitlement(
      db,
      { accountId, source: 'personal', state: entitlingState({ status: 'canceled' }), now: 2_000 },
      cause('operator', 'op-cancel'),
    );

    const audits = auditRows(db);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      previousPlan: 'tutor_pro_monthly',
      nextPlan: 'tutor_pro_monthly',
      previousStatus: 'active',
      nextStatus: 'canceled',
      createdAt: 2_000,
    });
  });

  it('treats a replayed cause with identical state as a silent no-op', () => {
    const accountId = account('writer-replay');
    writeEntitlement(
      db,
      write(accountId, entitlingState()),
      cause('processor_event', 'evt-replay'),
    );

    const replay = writeEntitlement(
      db,
      { ...write(accountId, entitlingState()), now: 2_000 },
      cause('processor_event', 'evt-replay'),
    );

    expect(replay).toEqual({ changed: false });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM entitlements`).get()).toEqual({ count: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM entitlement_audit`).get()).toEqual({
      count: 1,
    });
  });

  it('writes no audit row and does not bump updated_at when the state already matches', () => {
    const accountId = account('writer-noop');
    writeEntitlement(db, write(accountId, entitlingState()), cause('operator', 'op-first'));

    const noop = writeEntitlement(
      db,
      { ...write(accountId, entitlingState()), now: 2_000 },
      cause('operator', 'op-second'),
    );

    expect(noop).toEqual({ changed: false });
    expect(
      db
        .prepare(`SELECT updated_at AS updatedAt FROM entitlements WHERE account_id = ?`)
        .get(accountId),
    ).toEqual({ updatedAt: 1_000 });
    expect(auditRows(db)).toHaveLength(1);
  });

  it('writes when exactly one entitlement field differs from the stored row', () => {
    const companyId = 'co-field-diff';
    db.prepare(
      `INSERT INTO companies (company_id, name, created_at, updated_at)
       VALUES (?, 'Field Diff Co', 1, 1)`,
    ).run(companyId);

    const variants: Array<Partial<EntitlementState>> = [
      { planId: 'tutor_pro_annual' },
      { companyId },
      { currentPeriodEnd: 2_000 },
      { processorCustomerId: 'cus_diff' },
      { processorSubscriptionId: 'sub_diff' },
    ];
    for (const [index, override] of variants.entries()) {
      const variantAccount = account(`writer-field-diff-${index}`);
      writeEntitlement(
        db,
        write(variantAccount, entitlingState()),
        cause('operator', `op-field-base-${index}`),
      );
      expect(
        writeEntitlement(
          db,
          { ...write(variantAccount, entitlingState(override)), now: 2_000 },
          cause('operator', `op-field-change-${index}`),
        ),
      ).toEqual({ changed: true });
    }
    expect(auditRows(db)).toHaveLength(variants.length * 2);
  });

  it('opens a new grace deadline when only the grace deadline changed', () => {
    const accountId = account('writer-grace-diff');
    writeEntitlement(
      db,
      write(accountId, entitlingState({ status: 'past_due', graceUntil: 100 })),
      cause('operator', 'op-grace-base'),
    );

    expect(
      writeEntitlement(
        db,
        {
          ...write(accountId, entitlingState({ status: 'past_due', graceUntil: 200 })),
          now: 2_000,
        },
        cause('operator', 'op-grace-change'),
      ),
    ).toEqual({ changed: true });
    expect(
      db
        .prepare(`SELECT grace_until AS graceUntil FROM entitlements WHERE account_id = ?`)
        .get(accountId),
    ).toEqual({ graceUntil: 200 });
  });

  it('never bumps the authorization epoch or writes an authorization audit row', () => {
    const accountId = account('writer-epoch');
    const before = db
      .prepare(`SELECT authorization_epoch AS epoch FROM accounts WHERE account_id = ?`)
      .get(accountId);

    writeEntitlement(db, write(accountId, entitlingState()), cause('erasure', 'erasure-1'));

    expect(
      db
        .prepare(`SELECT authorization_epoch AS epoch FROM accounts WHERE account_id = ?`)
        .get(accountId),
    ).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM authorization_audit`).get()).toEqual({
      count: 0,
    });
  });

  it('rolls entitlement and audit rows back with the caller transaction', () => {
    const accountId = account('writer-rollback');

    expect(() =>
      db.transaction(() => {
        writeEntitlement(db, write(accountId, entitlingState()), cause('membership', 'invite-1'));
        throw new Error('caller rolled back');
      })(),
    ).toThrow('caller rolled back');

    expect(db.prepare(`SELECT COUNT(*) AS count FROM entitlements`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM entitlement_audit`).get()).toEqual({
      count: 0,
    });
  });

  it('rejects a cause without a usable actor or reason', () => {
    const accountId = account('writer-context');

    expect(() =>
      writeEntitlement(db, write(accountId, entitlingState()), {
        kind: 'operator',
        id: 'op-blank-actor',
        actor: '   ',
        reason: 'why',
      }),
    ).toThrow(IdentityInputError);
    expect(() =>
      writeEntitlement(db, write(accountId, entitlingState()), {
        kind: 'operator',
        id: 'op-blank-reason',
        actor: 'operator',
        reason: '  ',
      }),
    ).toThrow(IdentityInputError);

    expect(db.prepare(`SELECT COUNT(*) AS count FROM entitlements`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM entitlement_audit`).get()).toEqual({
      count: 0,
    });
  });

  it('reads entitlement rows back in camelCase for one account only', () => {
    const accountId = account('writer-read');
    const otherId = account('writer-read-other');
    db.prepare(
      `INSERT INTO companies (company_id, name, created_at, updated_at)
       VALUES ('read-company', 'Read Company', 1, 1)`,
    ).run();

    writeEntitlement(
      db,
      {
        accountId,
        source: 'personal',
        state: entitlingState({ planId: 'tutor_pro_annual', currentPeriodEnd: 1_234 }),
        now: 10,
      },
      cause('reconcile', 'reconcile-1'),
    );
    writeEntitlement(
      db,
      {
        accountId,
        source: 'company',
        state: entitlingState({
          planId: 'corporate_seat',
          status: 'trialing',
          companyId: 'read-company',
          collectionPaused: true,
        }),
        now: 20,
      },
      cause('seat_operation', 'seat-1'),
    );
    writeEntitlement(
      db,
      { accountId: otherId, source: 'personal', state: entitlingState(), now: 30 },
      cause('membership', 'invite-2'),
    );

    expect(readEntitlementsForAccount(db, accountId)).toEqual(
      expect.arrayContaining([
        {
          accountId,
          source: 'personal',
          planId: 'tutor_pro_annual',
          status: 'active',
          graceUntil: null,
          collectionPaused: false,
          companyId: null,
          currentPeriodEnd: 1_234,
          processorCustomerId: 'cus_1',
          processorSubscriptionId: 'sub_1',
          updatedAt: 10,
        },
        {
          accountId,
          source: 'company',
          planId: 'corporate_seat',
          status: 'trialing',
          graceUntil: null,
          collectionPaused: true,
          companyId: 'read-company',
          currentPeriodEnd: 1_800_000_000_000,
          processorCustomerId: 'cus_1',
          processorSubscriptionId: 'sub_1',
          updatedAt: 20,
        },
      ]),
    );
    expect(readEntitlementsForAccount(db, otherId)).toHaveLength(1);
  });
});

describe('entitlementWriter company seat reservations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function seatSubscription(companyId: string, quantity: number): void {
    db.prepare(
      `INSERT INTO companies (company_id, name, created_at, updated_at)
       VALUES (?, 'Seat Co', 1, 1)`,
    ).run(companyId);
    db.prepare(
      `INSERT INTO company_subscriptions (
         company_id, processor_subscription_id, quantity, status,
         collection_method, updated_at
       ) VALUES (?, ?, ?, 'active', 'charge_automatically', 1_000)`,
    ).run(companyId, `sub_${companyId}`, quantity);
  }

  function subscriptionRow(companyId: string): unknown {
    return db
      .prepare(
        `SELECT quantity, pending_quantity, pending_operation_id, updated_at
         FROM company_subscriptions WHERE company_id = ?`,
      )
      .get(companyId);
  }

  it('reserves a pending change without changing the billed quantity', () => {
    seatSubscription('seat-reserve', 3);

    const result = reserveCompanySeatChange(db, {
      companyId: 'seat-reserve',
      operationId: 'op-reserve',
      targetQuantity: 5,
      now: 2_000,
    });

    expect(result).toEqual({ updated: true });
    expect(subscriptionRow('seat-reserve')).toEqual({
      quantity: 3,
      pending_quantity: 5,
      pending_operation_id: 'op-reserve',
      updated_at: 2_000,
    });
  });

  it('applies the pending quantity when a reservation settles', () => {
    seatSubscription('seat-settle', 3);
    reserveCompanySeatChange(db, {
      companyId: 'seat-settle',
      operationId: 'op-settle',
      targetQuantity: 5,
      now: 2_000,
    });

    const result = settleCompanySeatChange(db, {
      companyId: 'seat-settle',
      operationId: 'op-settle',
      now: 3_000,
    });

    expect(result).toEqual({ updated: true });
    expect(subscriptionRow('seat-settle')).toEqual({
      quantity: 5,
      pending_quantity: null,
      pending_operation_id: null,
      updated_at: 3_000,
    });
  });

  it('clears a reservation without applying it when it is released', () => {
    seatSubscription('seat-release', 5);
    reserveCompanySeatChange(db, {
      companyId: 'seat-release',
      operationId: 'op-release',
      targetQuantity: 2,
      now: 2_000,
    });

    const result = releaseCompanySeatChange(db, {
      companyId: 'seat-release',
      operationId: 'op-release',
      now: 3_000,
    });

    expect(result).toEqual({ updated: true });
    expect(subscriptionRow('seat-release')).toEqual({
      quantity: 5,
      pending_quantity: null,
      pending_operation_id: null,
      updated_at: 3_000,
    });
  });

  it('reports no update for seat operations that match no subscription', () => {
    seatSubscription('seat-missing', 3);

    expect(
      reserveCompanySeatChange(db, {
        companyId: 'seat-absent',
        operationId: 'op-absent',
        targetQuantity: 5,
        now: 2_000,
      }),
    ).toEqual({ updated: false });
    expect(
      settleCompanySeatChange(db, {
        companyId: 'seat-missing',
        operationId: 'op-wrong',
        now: 2_000,
      }),
    ).toEqual({ updated: false });
    expect(
      releaseCompanySeatChange(db, {
        companyId: 'seat-missing',
        operationId: 'op-wrong',
        now: 2_000,
      }),
    ).toEqual({ updated: false });
  });
});

describe('entitlementWriter company entitlement deletion (C-11/C-13)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function account(subject: string): string {
    const outcome = resolveAccountForSubject(db, {
      issuer: 'https://issuer',
      subject,
    });
    if (isTutorCapReached(outcome)) throw new Error('unexpected tutor cap outcome');
    return outcome.account.accountId;
  }

  function company(companyId: string): void {
    db.prepare(
      `INSERT INTO companies (company_id, name, created_at, updated_at)
       VALUES (?, 'Delete Co', 1, 1)`,
    ).run(companyId);
  }

  function seedCompanyRow(accountId: string, companyId: string, id: string): void {
    writeEntitlement(
      db,
      {
        accountId,
        source: 'company',
        state: entitlingState({ planId: 'corporate_seat', companyId }),
        now: 10,
      },
      cause('membership', id),
    );
  }

  it('deletes one member company row with one audit row and leaves other rows alone', () => {
    const companyId = 'co-delete-main';
    const otherCompanyId = 'co-delete-other';
    company(companyId);
    company(otherCompanyId);
    const memberId = account('delete-member');
    const otherId = account('delete-other');
    writeEntitlement(
      db,
      { accountId: memberId, source: 'personal', state: entitlingState(), now: 10 },
      cause('operator', 'keep-personal'),
    );
    seedCompanyRow(memberId, companyId, 'seed-main');
    seedCompanyRow(otherId, otherCompanyId, 'seed-other');

    const result = deleteCompanyEntitlement(db, {
      companyId,
      accountId: memberId,
      cause: cause('membership', 'delete-main'),
      now: 5_000,
    });

    expect(result).toEqual({ deleted: true });
    expect(readEntitlementsForAccount(db, memberId).map((row) => row.source)).toEqual([
      'personal',
    ]);
    expect(readEntitlementsForAccount(db, otherId)).toHaveLength(1);
    expect(
      auditRows(db).filter((row) => row.causeId === 'delete-main'),
    ).toEqual([
      {
        auditId: expect.any(String),
        subjectKind: 'account',
        subjectId: memberId,
        action: 'entitlement_change',
        causeKind: 'membership',
        causeId: 'delete-main',
        actor: 'test-operator',
        reason: 'writer test',
        previousPlan: 'corporate_seat',
        nextPlan: null,
        previousStatus: 'active',
        nextStatus: null,
        processorEventId: null,
        createdAt: 5_000,
      },
    ]);
  });

  it('changes nothing for another company or an absent row and never repeats the audit', () => {
    const companyId = 'co-delete-guard';
    company(companyId);
    const memberId = account('delete-guard-member');
    seedCompanyRow(memberId, companyId, 'seed-guard');

    const wrongCompany = deleteCompanyEntitlement(db, {
      companyId: 'co-not-mine',
      accountId: memberId,
      cause: cause('membership', 'delete-wrong-company'),
      now: 5_000,
    });
    expect(wrongCompany).toEqual({ deleted: false });
    expect(readEntitlementsForAccount(db, memberId)).toHaveLength(1);
    expect(auditRows(db).filter((row) => row.causeId === 'delete-wrong-company')).toEqual([]);

    const deleted = deleteCompanyEntitlement(db, {
      companyId,
      accountId: memberId,
      cause: cause('membership', 'delete-once'),
      now: 5_000,
    });
    expect(deleted).toEqual({ deleted: true });
    const replay = deleteCompanyEntitlement(db, {
      companyId,
      accountId: memberId,
      cause: cause('membership', 'delete-once'),
      now: 6_000,
    });
    expect(replay).toEqual({ deleted: false });
    expect(auditRows(db).filter((row) => row.causeId === 'delete-once')).toHaveLength(1);
  });
});

describe('entitlementWriter operator actions and invoice subscription (O-1/O-2)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('records one operator audit row per cause and skips a replayed cause', () => {
    const cause = {
      kind: 'operator' as const,
      id: 'op-approve-1',
      actor: 'operator:ops@example.test',
      reason: 'invoice approval',
    };

    const recorded = recordOperatorAction(db, {
      subjectKind: 'company',
      subjectId: 'co-audit',
      cause,
      now: 7_000,
    });
    expect(recorded).toEqual({ recorded: true });

    const replay = recordOperatorAction(db, {
      subjectKind: 'company',
      subjectId: 'co-audit',
      cause,
      now: 8_000,
    });
    expect(replay).toEqual({ recorded: false });

    expect(auditRows(db)).toEqual([
      {
        auditId: expect.any(String),
        subjectKind: 'company',
        subjectId: 'co-audit',
        action: 'operator_action',
        causeKind: 'operator',
        causeId: 'op-approve-1',
        actor: 'operator:ops@example.test',
        reason: 'invoice approval',
        previousPlan: null,
        nextPlan: null,
        previousStatus: null,
        nextStatus: null,
        processorEventId: null,
        createdAt: 7_000,
      },
    ]);
  });

  it('rejects an operator audit without an actor or reason', () => {
    expect(() =>
      recordOperatorAction(db, {
        subjectKind: 'company',
        subjectId: 'co-blank',
        cause: { kind: 'operator', id: 'op-blank', actor: '  ', reason: 'why' },
        now: 1_000,
      }),
    ).toThrow(IdentityInputError);
    expect(() =>
      recordOperatorAction(db, {
        subjectKind: 'company',
        subjectId: 'co-blank',
        cause: { kind: 'operator', id: 'op-blank', actor: 'operator:x', reason: '' },
        now: 1_000,
      }),
    ).toThrow(IdentityInputError);
    expect(auditRows(db)).toEqual([]);
  });

  it('attaches a send_invoice company subscription awaiting its first payment', () => {
    db.prepare(
      `INSERT INTO companies (company_id, name, created_at, updated_at)
       VALUES ('co-attach', 'Attach Co', 1, 1)`,
    ).run();

    const result = attachCompanySubscription(db, {
      companyId: 'co-attach',
      processorSubscriptionId: 'sub_attach_1',
      quantity: 12,
      status: 'active',
      collectionMethod: 'send_invoice',
      currentPeriodEnd: 9_000,
      hostedInvoiceUrl: 'https://invoice.stripe.test/in_attach_1',
      now: 5_000,
    });

    expect(result).toEqual({ created: true });
    expect(
      db
        .prepare(
          `SELECT quantity, status, collection_method AS collectionMethod,
                  collection_paused AS collectionPaused, first_paid_at AS firstPaidAt,
                  hosted_invoice_url AS hostedInvoiceUrl,
                  current_period_end AS currentPeriodEnd, grace_until AS graceUntil
           FROM company_subscriptions WHERE company_id = 'co-attach'`,
        )
        .get(),
    ).toEqual({
      quantity: 12,
      status: 'active',
      collectionMethod: 'send_invoice',
      collectionPaused: 0,
      firstPaidAt: null,
      hostedInvoiceUrl: 'https://invoice.stripe.test/in_attach_1',
      currentPeriodEnd: 9_000,
      graceUntil: null,
    });
  });

  it('refuses to attach a second subscription to the same company', () => {
    db.prepare(
      `INSERT INTO companies (company_id, name, created_at, updated_at)
       VALUES ('co-attach-twice', 'Attach Twice Co', 1, 1)`,
    ).run();
    const input = {
      companyId: 'co-attach-twice',
      processorSubscriptionId: 'sub_attach_twice',
      quantity: 12,
      status: 'active' as const,
      collectionMethod: 'send_invoice' as const,
      currentPeriodEnd: null,
      hostedInvoiceUrl: null,
      now: 5_000,
    };

    expect(attachCompanySubscription(db, input)).toEqual({ created: true });
    expect(
      attachCompanySubscription(db, {
        ...input,
        processorSubscriptionId: 'sub_attach_other',
        now: 6_000,
      }),
    ).toEqual({ created: false });
    expect(
      db
        .prepare(
          `SELECT processor_subscription_id AS processorSubscriptionId
           FROM company_subscriptions WHERE company_id = 'co-attach-twice'`,
        )
        .get(),
    ).toEqual({ processorSubscriptionId: 'sub_attach_twice' });
  });
});

interface OrderingRow {
  subject_id: string;
  last_state_event_created: number;
  processor_canceled_at: number | null;
  desired_collection: string;
  desired_version: number;
  applied_version: number;
  in_flight_version: number | null;
  in_flight_state: string | null;
  in_flight_since: number | null;
}

describe('entitlementWriter billing collection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function account(subject: string): string {
    const outcome = resolveAccountForSubject(db, {
      issuer: 'https://issuer',
      subject,
    });
    if (isTutorCapReached(outcome)) throw new Error('unexpected tutor cap outcome');
    return outcome.account.accountId;
  }

  function company(companyId: string): void {
    db.prepare(
      `INSERT INTO companies (company_id, name, created_at, updated_at)
       VALUES (?, 'Billing Co', 1, 1)`,
    ).run(companyId);
  }

  function ensure(processorSubscriptionId: string, subjectId: string): void {
    ensureBillingSubscription(db, {
      processorSubscriptionId,
      subjectKind: 'account',
      subjectId,
      now: 1,
    });
  }

  function ordering(processorSubscriptionId: string): OrderingRow | undefined {
    return db
      .prepare(
        `SELECT subject_id, last_state_event_created, processor_canceled_at,
                desired_collection, desired_version, applied_version,
                in_flight_version, in_flight_state, in_flight_since
         FROM billing_subscriptions WHERE processor_subscription_id = ?`,
      )
      .get(processorSubscriptionId) as OrderingRow | undefined;
  }

  function entitlement(accountId: string): Record<string, unknown> | undefined {
    return db
      .prepare(
        `SELECT plan_id, status, grace_until, collection_paused, company_id,
                current_period_end, processor_customer_id, processor_subscription_id
         FROM entitlements WHERE account_id = ? AND source = 'personal'`,
      )
      .get(accountId) as Record<string, unknown> | undefined;
  }

  function companySubscription(processorSubscriptionId: string): Record<string, unknown> | undefined {
    return db
      .prepare(
        `SELECT status, grace_until, collection_paused, current_period_end
         FROM company_subscriptions WHERE processor_subscription_id = ?`,
      )
      .get(processorSubscriptionId) as Record<string, unknown> | undefined;
  }

  function attach(
    companyId: string,
    processorSubscriptionId: string,
    status: 'trialing' | 'active',
  ): void {
    company(companyId);
    attachCompanySubscription(db, {
      companyId,
      processorSubscriptionId,
      quantity: 3,
      status,
      collectionMethod: 'send_invoice',
      currentPeriodEnd: null,
      hostedInvoiceUrl: null,
      now: 100,
    });
  }

  function applyPersonal(
    processorSubscriptionId: string,
    accountId: string,
    eventCreated: number,
    fetched: {
      status: 'active' | 'past_due' | 'canceled';
      currentPeriodEnd: number | null;
      canceledAt: number | null;
      pauseCollection: boolean;
    },
    now = eventCreated,
  ) {
    return applySubscriptionState(
      db,
      {
        processorSubscriptionId,
        accountId,
        planId: 'tutor_pro_monthly',
        processorCustomerId: 'cus_billing',
        eventCreated,
        now,
        fetched,
      },
      cause('processor_event', `evt_${processorSubscriptionId}_${eventCreated}`),
    );
  }

  function applyCompany(
    processorSubscriptionId: string,
    companyId: string,
    eventCreated: number,
    fetched: {
      status: 'trialing' | 'active' | 'past_due' | 'canceled';
      currentPeriodEnd: number | null;
      canceledAt: number | null;
      pauseCollection: boolean;
    },
    now = eventCreated,
  ) {
    return applyCompanySubscriptionState(db, {
      processorSubscriptionId,
      companyId,
      eventCreated,
      now,
      fetched,
    });
  }

  it('applies a fetched active state and advances the ordering watermark', () => {
    const accountId = account('billing-apply-active');

    const result = applyPersonal('sub_apply_active', accountId, 100, {
      status: 'active',
      currentPeriodEnd: 9_000,
      canceledAt: null,
      pauseCollection: false,
    }, 1_000);

    expect(result).toEqual({ applied: true, canceledNow: false });
    expect(ordering('sub_apply_active')).toMatchObject({
      subject_id: accountId,
      last_state_event_created: 100,
      processor_canceled_at: null,
      desired_version: 0,
      applied_version: 0,
      in_flight_version: null,
    });
    expect(entitlement(accountId)).toEqual({
      plan_id: 'tutor_pro_monthly',
      status: 'active',
      grace_until: null,
      collection_paused: 0,
      company_id: null,
      current_period_end: 9_000,
      processor_customer_id: 'cus_billing',
      processor_subscription_id: 'sub_apply_active',
    });
    expect(auditRows(db)).toHaveLength(1);
  });

  it('does not apply a state when the ordering row cannot be created', () => {
    const result = applySubscriptionState(
      db,
      {
        processorSubscriptionId: 'sub_unorderable',
        accountId: '',
        planId: 'tutor_pro_monthly',
        processorCustomerId: null,
        eventCreated: 100,
        now: 1_000,
        fetched: {
          status: 'active',
          currentPeriodEnd: null,
          canceledAt: null,
          pauseCollection: false,
        },
      },
      cause('processor_event', 'evt_unorderable'),
    );

    expect(result).toEqual({ applied: false, canceledNow: false });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM billing_subscriptions`).get()).toEqual({
      count: 0,
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM entitlements`).get()).toEqual({ count: 0 });
    expect(auditRows(db)).toEqual([]);
  });

  it('ignores an event older than the applied watermark', () => {
    const accountId = account('billing-apply-stale');
    expect(applyPersonal('sub_apply_stale', accountId, 200, {
      status: 'active',
      currentPeriodEnd: 9_000,
      canceledAt: null,
      pauseCollection: false,
    })).toEqual({ applied: true, canceledNow: false });

    expect(applyPersonal('sub_apply_stale', accountId, 100, {
      status: 'canceled',
      currentPeriodEnd: 9_000,
      canceledAt: 150,
      pauseCollection: false,
    })).toEqual({ applied: false, canceledNow: false });

    expect(entitlement(accountId)?.status).toBe('active');
    expect(ordering('sub_apply_stale')?.last_state_event_created).toBe(200);
    expect(auditRows(db)).toHaveLength(1);
  });

  it('absorbs a processor cancel and refuses later events', () => {
    const accountId = account('billing-apply-cancel');
    expect(applyPersonal('sub_apply_cancel', accountId, 100, {
      status: 'canceled',
      currentPeriodEnd: null,
      canceledAt: 150,
      pauseCollection: false,
    })).toEqual({ applied: true, canceledNow: true });

    expect(ordering('sub_apply_cancel')?.processor_canceled_at).toBe(150);
    expect(entitlement(accountId)?.status).toBe('canceled');

    expect(applyPersonal('sub_apply_cancel', accountId, 200, {
      status: 'active',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: false,
    })).toEqual({ applied: false, canceledNow: false });
    expect(entitlement(accountId)?.status).toBe('canceled');
  });

  it('tombstones a cancel without a timestamp at the write clock', () => {
    const accountId = account('billing-apply-cancel-now');
    expect(applyPersonal('sub_apply_cancel_now', accountId, 100, {
      status: 'canceled',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: false,
    }, 7_000)).toEqual({ applied: true, canceledNow: true });

    expect(ordering('sub_apply_cancel_now')?.processor_canceled_at).toBe(7_000);
  });

  it('opens a grace window on the first past_due and keeps its deadline', () => {
    const accountId = account('billing-apply-past-due');
    expect(applyPersonal('sub_apply_past_due', accountId, 1_000, {
      status: 'past_due',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: true,
    })).toEqual({ applied: true, canceledNow: false });

    expect(entitlement(accountId)).toMatchObject({
      status: 'past_due',
      grace_until: 1_000 + PAST_DUE_GRACE_MS,
      collection_paused: 1,
    });

    expect(applyPersonal('sub_apply_past_due', accountId, 2_000, {
      status: 'past_due',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: true,
    })).toEqual({ applied: true, canceledNow: false });
    expect(entitlement(accountId)?.grace_until).toBe(1_000 + PAST_DUE_GRACE_MS);
  });

  it('keeps the company binding on a personal subscription update', () => {
    const accountId = account('billing-apply-company-bind');
    company('co-billing-bind');
    writeEntitlement(
      db,
      {
        accountId,
        source: 'personal',
        state: entitlingState({ planId: 'corporate_seat', companyId: 'co-billing-bind' }),
        now: 10,
      },
      cause('membership', 'co-bind'),
    );

    expect(applyPersonal('sub_company_bind', accountId, 50, {
      status: 'active',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: true,
    }, 60)).toEqual({ applied: true, canceledNow: false });

    expect(entitlement(accountId)).toMatchObject({
      plan_id: 'tutor_pro_monthly',
      status: 'active',
      company_id: 'co-billing-bind',
      collection_paused: 1,
    });
  });

  it('applies a fetched company subscription state', () => {
    attach('co-apply', 'sub_company_apply', 'trialing');

    expect(applyCompany('sub_company_apply', 'co-apply', 500, {
      status: 'active',
      currentPeriodEnd: 88_000,
      canceledAt: null,
      pauseCollection: true,
    }, 600)).toEqual({ applied: true, canceledNow: false });

    expect(companySubscription('sub_company_apply')).toEqual({
      status: 'active',
      grace_until: null,
      collection_paused: 1,
      current_period_end: 88_000,
    });
    expect(ordering('sub_company_apply')).toMatchObject({
      subject_id: 'co-apply',
      last_state_event_created: 500,
      processor_canceled_at: null,
    });
  });

  it('does not apply a company state when the ordering row cannot be created', () => {
    expect(applyCompany('sub_company_unorderable', '', 100, {
      status: 'active',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: false,
    })).toEqual({ applied: false, canceledNow: false });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM billing_subscriptions`).get()).toEqual({
      count: 0,
    });
  });

  it('does not apply a company state without a company subscription row', () => {
    expect(applyCompany('sub_company_missing', 'co-missing-subscription', 100, {
      status: 'active',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: false,
    })).toEqual({ applied: false, canceledNow: false });
    expect(ordering('sub_company_missing')).toMatchObject({ subject_id: 'co-missing-subscription' });
  });

  it('ignores stale company events and absorbs a company cancel', () => {
    attach('co-company-events', 'sub_company_events', 'trialing');

    expect(applyCompany('sub_company_events', 'co-company-events', 900, {
      status: 'active',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: false,
    })).toEqual({ applied: true, canceledNow: false });

    expect(applyCompany('sub_company_events', 'co-company-events', 800, {
      status: 'active',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: false,
    })).toEqual({ applied: false, canceledNow: false });

    expect(applyCompany('sub_company_events', 'co-company-events', 950, {
      status: 'canceled',
      currentPeriodEnd: null,
      canceledAt: 960,
      pauseCollection: false,
    })).toEqual({ applied: true, canceledNow: true });
    expect(ordering('sub_company_events')?.processor_canceled_at).toBe(960);
    expect(companySubscription('sub_company_events')?.status).toBe('canceled');

    expect(applyCompany('sub_company_events', 'co-company-events', 1_000, {
      status: 'active',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: false,
    })).toEqual({ applied: false, canceledNow: false });
  });

  it('tombstones a company cancel without a timestamp at the write clock', () => {
    attach('co-company-cancel-now', 'sub_company_cancel_now', 'active');

    expect(applyCompany('sub_company_cancel_now', 'co-company-cancel-now', 100, {
      status: 'canceled',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: false,
    }, 8_000)).toEqual({ applied: true, canceledNow: true });
    expect(ordering('sub_company_cancel_now')?.processor_canceled_at).toBe(8_000);
  });

  it('opens a company grace window once for repeated past_due states', () => {
    attach('co-company-grace', 'sub_company_grace', 'active');

    expect(applyCompany('sub_company_grace', 'co-company-grace', 300, {
      status: 'past_due',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: true,
    })).toEqual({ applied: true, canceledNow: false });
    expect(companySubscription('sub_company_grace')).toMatchObject({
      status: 'past_due',
      grace_until: 300 + PAST_DUE_GRACE_MS,
      collection_paused: 1,
    });

    expect(applyCompany('sub_company_grace', 'co-company-grace', 400, {
      status: 'past_due',
      currentPeriodEnd: null,
      canceledAt: null,
      pauseCollection: true,
    })).toEqual({ applied: true, canceledNow: false });
    expect(companySubscription('sub_company_grace')?.grace_until).toBe(300 + PAST_DUE_GRACE_MS);
  });

  it('reports an unknown collection as unchanged when canceling', () => {
    expect(cancelCollection(db, { processorSubscriptionId: 'sub_unknown', now: 1 })).toEqual({
      changed: false,
      desiredVersion: 0,
    });
  });

  it('is absorbing once the collection is canceled with nothing in flight', () => {
    const accountId = account('billing-cancel-idle');
    ensure('sub_cancel_idle', accountId);

    expect(cancelCollection(db, { processorSubscriptionId: 'sub_cancel_idle', now: 10 })).toEqual({
      changed: true,
      desiredVersion: 1,
    });
    expect(cancelCollection(db, { processorSubscriptionId: 'sub_cancel_idle', now: 20 })).toEqual({
      changed: false,
      desiredVersion: 1,
    });
    expect(ordering('sub_cancel_idle')).toMatchObject({
      desired_collection: 'canceled',
      desired_version: 1,
      applied_version: 1,
      in_flight_version: null,
    });
  });

  it('clears an in-flight collection when the desire is already canceled', () => {
    const accountId = account('billing-cancel-flight');
    ensure('sub_cancel_flight', accountId);
    upsertDisputeHold(db, {
      disputeId: 'dp_cancel_flight',
      processorSubscriptionId: 'sub_cancel_flight',
      state: 'open',
      now: 2,
    });
    expect(
      recomputeDesiredCollection(db, {
        processorSubscriptionId: 'sub_cancel_flight',
        cause: cause('reconcile', 'rc_pause_flight'),
        now: 3,
      }),
    ).toEqual({ changed: true, desired: 'paused' });
    expect(claimCollection(db, { processorSubscriptionId: 'sub_cancel_flight', now: 4 })).toEqual({
      claimed: true,
      inFlightVersion: 1,
      inFlightState: 'paused',
    });
    upsertDisputeHold(db, {
      disputeId: 'dp_cancel_flight',
      processorSubscriptionId: 'sub_cancel_flight',
      state: 'lost',
      now: 5,
    });
    expect(
      recomputeDesiredCollection(db, {
        processorSubscriptionId: 'sub_cancel_flight',
        cause: cause('reconcile', 'rc_cancel_flight'),
        now: 6,
      }),
    ).toEqual({ changed: true, desired: 'canceled' });
    expect(ordering('sub_cancel_flight')).toMatchObject({
      desired_version: 2,
      in_flight_version: 1,
    });

    expect(cancelCollection(db, { processorSubscriptionId: 'sub_cancel_flight', now: 7 })).toEqual({
      changed: true,
      desiredVersion: 3,
    });
    expect(ordering('sub_cancel_flight')).toMatchObject({
      desired_collection: 'canceled',
      desired_version: 3,
      applied_version: 3,
      in_flight_version: null,
      in_flight_state: null,
      in_flight_since: null,
    });
  });

  it('moves a dispute hold forward only', () => {
    ensure('sub_hold', account('billing-hold'));

    expect(
      upsertDisputeHold(db, {
        disputeId: 'dp_hold',
        processorSubscriptionId: 'sub_hold',
        state: 'open',
        now: 10,
      }),
    ).toEqual({ stateChanged: true, state: 'open' });
    expect(
      upsertDisputeHold(db, {
        disputeId: 'dp_hold',
        processorSubscriptionId: 'sub_hold',
        state: 'review',
        now: 20,
      }),
    ).toEqual({ stateChanged: true, state: 'review' });
    expect(
      upsertDisputeHold(db, {
        disputeId: 'dp_hold',
        processorSubscriptionId: 'sub_hold',
        state: 'open',
        now: 30,
      }),
    ).toEqual({ stateChanged: false, state: 'review' });
    expect(
      upsertDisputeHold(db, {
        disputeId: 'dp_hold',
        processorSubscriptionId: 'sub_hold',
        state: 'won',
        now: 40,
      }),
    ).toEqual({ stateChanged: true, state: 'won' });
    expect(
      upsertDisputeHold(db, {
        disputeId: 'dp_hold',
        processorSubscriptionId: 'sub_hold',
        state: 'lost',
        now: 50,
      }),
    ).toEqual({ stateChanged: true, state: 'lost' });
    expect(
      upsertDisputeHold(db, {
        disputeId: 'dp_hold',
        processorSubscriptionId: 'sub_hold',
        state: 'won',
        now: 60,
      }),
    ).toEqual({ stateChanged: false, state: 'lost' });

    expect(
      db
        .prepare(
          `SELECT state, first_seen_at AS firstSeenAt, closed_at AS closedAt
           FROM billing_dispute_holds WHERE dispute_id = 'dp_hold'`,
        )
        .get(),
    ).toEqual({ state: 'lost', firstSeenAt: 10, closedAt: 50 });
  });

  it('reports an unknown subscription as active when recomputing', () => {
    expect(
      recomputeDesiredCollection(db, {
        processorSubscriptionId: 'sub_unknown',
        cause: cause('reconcile', 'rc_unknown'),
        now: 1,
      }),
    ).toEqual({ changed: false, desired: 'active' });
  });

  it('never revives a canceled collection', () => {
    const accountId = account('billing-recompute-canceled');
    ensure('sub_recompute_canceled', accountId);
    cancelCollection(db, { processorSubscriptionId: 'sub_recompute_canceled', now: 10 });
    upsertDisputeHold(db, {
      disputeId: 'dp_recompute_canceled',
      processorSubscriptionId: 'sub_recompute_canceled',
      state: 'open',
      now: 11,
    });

    expect(
      recomputeDesiredCollection(db, {
        processorSubscriptionId: 'sub_recompute_canceled',
        cause: cause('reconcile', 'rc_canceled'),
        now: 12,
      }),
    ).toEqual({ changed: false, desired: 'canceled' });
  });

  it('maps open and lost dispute holds onto the desired collection', () => {
    const accountId = account('billing-recompute-holes');
    ensure('sub_recompute_holes', accountId);
    const recompute = (now: number) =>
      recomputeDesiredCollection(db, {
        processorSubscriptionId: 'sub_recompute_holes',
        cause: cause('reconcile', `rc_holes_${now}`),
        now,
      });

    upsertDisputeHold(db, {
      disputeId: 'dp_holes',
      processorSubscriptionId: 'sub_recompute_holes',
      state: 'open',
      now: 1,
    });
    expect(recompute(2)).toEqual({ changed: true, desired: 'paused' });

    upsertDisputeHold(db, {
      disputeId: 'dp_holes',
      processorSubscriptionId: 'sub_recompute_holes',
      state: 'review',
      now: 3,
    });
    expect(recompute(4)).toEqual({ changed: false, desired: 'paused' });

    upsertDisputeHold(db, {
      disputeId: 'dp_holes',
      processorSubscriptionId: 'sub_recompute_holes',
      state: 'won',
      now: 5,
    });
    expect(recompute(6)).toEqual({ changed: true, desired: 'active' });
    expect(recompute(7)).toEqual({ changed: false, desired: 'active' });

    upsertDisputeHold(db, {
      disputeId: 'dp_holes_lost',
      processorSubscriptionId: 'sub_recompute_holes',
      state: 'lost',
      now: 8,
    });
    expect(recompute(9)).toEqual({ changed: true, desired: 'canceled' });
  });

  it('projects the desired pause onto the member entitlement', () => {
    const accountId = account('billing-recompute-member');
    writeEntitlement(
      db,
      { accountId, source: 'personal', state: entitlingState(), now: 5 },
      cause('operator', 'op_recompute_member'),
    );
    ensure('sub_recompute_member', accountId);
    upsertDisputeHold(db, {
      disputeId: 'dp_recompute_member',
      processorSubscriptionId: 'sub_recompute_member',
      state: 'open',
      now: 6,
    });

    expect(
      recomputeDesiredCollection(db, {
        processorSubscriptionId: 'sub_recompute_member',
        cause: cause('reconcile', 'rc_member'),
        now: 7,
      }),
    ).toEqual({ changed: true, desired: 'paused' });

    expect(entitlement(accountId)).toMatchObject({
      collection_paused: 1,
      processor_subscription_id: 'sub_1',
    });
    expect(auditRows(db).filter((row) => row.causeId === 'rc_member')).toHaveLength(1);
  });

  it('claims the desired version once and reports the held claim afterwards', () => {
    const accountId = account('billing-claim');
    expect(claimCollection(db, { processorSubscriptionId: 'sub_claim_unknown', now: 1 })).toEqual({
      claimed: false,
      inFlightVersion: null,
      inFlightState: null,
    });

    ensure('sub_claim', accountId);
    expect(claimCollection(db, { processorSubscriptionId: 'sub_claim', now: 2 })).toEqual({
      claimed: false,
      inFlightVersion: null,
      inFlightState: null,
    });

    upsertDisputeHold(db, {
      disputeId: 'dp_claim',
      processorSubscriptionId: 'sub_claim',
      state: 'open',
      now: 3,
    });
    recomputeDesiredCollection(db, {
      processorSubscriptionId: 'sub_claim',
      cause: cause('reconcile', 'rc_claim'),
      now: 4,
    });

    expect(claimCollection(db, { processorSubscriptionId: 'sub_claim', now: 5 })).toEqual({
      claimed: true,
      inFlightVersion: 1,
      inFlightState: 'paused',
    });
    expect(claimCollection(db, { processorSubscriptionId: 'sub_claim', now: 6 })).toEqual({
      claimed: false,
      inFlightVersion: 1,
      inFlightState: 'paused',
    });
    expect(ordering('sub_claim')).toMatchObject({
      in_flight_version: 1,
      in_flight_state: 'paused',
      in_flight_since: 5,
    });
  });

  it('settles a claim and immediately claims a newer desire', () => {
    const accountId = account('billing-settle-ok');
    ensure('sub_settle_ok', accountId);
    upsertDisputeHold(db, {
      disputeId: 'dp_settle_ok',
      processorSubscriptionId: 'sub_settle_ok',
      state: 'open',
      now: 1,
    });
    recomputeDesiredCollection(db, {
      processorSubscriptionId: 'sub_settle_ok',
      cause: cause('reconcile', 'rc_settle_ok_pause'),
      now: 2,
    });
    claimCollection(db, { processorSubscriptionId: 'sub_settle_ok', now: 3 });
    upsertDisputeHold(db, {
      disputeId: 'dp_settle_ok',
      processorSubscriptionId: 'sub_settle_ok',
      state: 'won',
      now: 4,
    });
    recomputeDesiredCollection(db, {
      processorSubscriptionId: 'sub_settle_ok',
      cause: cause('reconcile', 'rc_settle_ok_resume'),
      now: 5,
    });
    expect(ordering('sub_settle_ok')).toMatchObject({
      desired_version: 2,
      in_flight_version: 1,
    });

    expect(
      settleCollectionSuccess(db, {
        processorSubscriptionId: 'sub_settle_ok',
        expectedVersion: 1,
        now: 6,
      }),
    ).toEqual({ settled: true, reason: 'ok' });
    expect(ordering('sub_settle_ok')).toMatchObject({
      applied_version: 1,
      in_flight_version: 2,
      in_flight_state: 'active',
      in_flight_since: 6,
    });
  });

  it('settles a claim without a newer desire pending', () => {
    const accountId = account('billing-settle-last');
    ensure('sub_settle_last', accountId);
    upsertDisputeHold(db, {
      disputeId: 'dp_settle_last',
      processorSubscriptionId: 'sub_settle_last',
      state: 'open',
      now: 1,
    });
    recomputeDesiredCollection(db, {
      processorSubscriptionId: 'sub_settle_last',
      cause: cause('reconcile', 'rc_settle_last'),
      now: 2,
    });
    claimCollection(db, { processorSubscriptionId: 'sub_settle_last', now: 3 });

    expect(
      settleCollectionSuccess(db, {
        processorSubscriptionId: 'sub_settle_last',
        expectedVersion: 1,
        now: 4,
      }),
    ).toEqual({ settled: true, reason: 'ok' });
    expect(ordering('sub_settle_last')).toMatchObject({
      desired_version: 1,
      applied_version: 1,
      in_flight_version: null,
      in_flight_state: null,
      in_flight_since: null,
    });
  });

  it('reports why a collection settle did not apply', () => {
    const accountId = account('billing-settle-reasons');
    expect(
      settleCollectionSuccess(db, {
        processorSubscriptionId: 'sub_settle_unknown',
        expectedVersion: 1,
        now: 1,
      }),
    ).toEqual({ settled: false, reason: 'missing' });

    ensure('sub_settle_reasons', accountId);
    expect(
      settleCollectionSuccess(db, {
        processorSubscriptionId: 'sub_settle_reasons',
        expectedVersion: 0,
        now: 2,
      }),
    ).toEqual({ settled: true, reason: 'already_applied' });

    upsertDisputeHold(db, {
      disputeId: 'dp_settle_reasons',
      processorSubscriptionId: 'sub_settle_reasons',
      state: 'open',
      now: 3,
    });
    recomputeDesiredCollection(db, {
      processorSubscriptionId: 'sub_settle_reasons',
      cause: cause('reconcile', 'rc_settle_reasons'),
      now: 4,
    });
    expect(
      settleCollectionSuccess(db, {
        processorSubscriptionId: 'sub_settle_reasons',
        expectedVersion: 1,
        now: 5,
      }),
    ).toEqual({ settled: false, reason: 'not_claimed' });

    claimCollection(db, { processorSubscriptionId: 'sub_settle_reasons', now: 6 });
    expect(
      settleCollectionSuccess(db, {
        processorSubscriptionId: 'sub_settle_reasons',
        expectedVersion: 2,
        now: 7,
      }),
    ).toEqual({ settled: false, reason: 'stale' });
    expect(ordering('sub_settle_reasons')).toMatchObject({
      applied_version: 0,
      in_flight_version: 1,
    });
  });

  it('clears a failed claim and reports why it did not clear', () => {
    const accountId = account('billing-failure');
    expect(
      settleCollectionFailure(db, {
        processorSubscriptionId: 'sub_failure_unknown',
        expectedVersion: 1,
        now: 1,
      }),
    ).toEqual({ cleared: false, reason: 'missing' });

    ensure('sub_failure', accountId);
    expect(
      settleCollectionFailure(db, {
        processorSubscriptionId: 'sub_failure',
        expectedVersion: 0,
        now: 2,
      }),
    ).toEqual({ cleared: false, reason: 'not_claimed' });

    upsertDisputeHold(db, {
      disputeId: 'dp_failure',
      processorSubscriptionId: 'sub_failure',
      state: 'open',
      now: 3,
    });
    recomputeDesiredCollection(db, {
      processorSubscriptionId: 'sub_failure',
      cause: cause('reconcile', 'rc_failure'),
      now: 4,
    });
    claimCollection(db, { processorSubscriptionId: 'sub_failure', now: 5 });
    expect(
      settleCollectionFailure(db, {
        processorSubscriptionId: 'sub_failure',
        expectedVersion: 2,
        now: 6,
      }),
    ).toEqual({ cleared: false, reason: 'stale' });

    expect(
      settleCollectionFailure(db, {
        processorSubscriptionId: 'sub_failure',
        expectedVersion: 1,
        now: 7,
      }),
    ).toEqual({ cleared: true, reason: 'ok' });
    expect(ordering('sub_failure')).toMatchObject({
      desired_version: 1,
      applied_version: 0,
      in_flight_version: null,
      in_flight_state: null,
      in_flight_since: null,
    });
  });

  it('repairs a collection version and reclaims it', () => {
    const accountId = account('billing-repair');
    expect(
      repairCollectionVersion(db, { processorSubscriptionId: 'sub_repair_unknown', now: 1 }),
    ).toEqual({ repaired: false, desiredVersion: 0, inFlightState: null });

    ensure('sub_repair', accountId);
    expect(repairCollectionVersion(db, { processorSubscriptionId: 'sub_repair', now: 2 })).toEqual({
      repaired: true,
      desiredVersion: 1,
      inFlightState: 'active',
    });
    expect(ordering('sub_repair')).toMatchObject({
      desired_version: 1,
      in_flight_version: 1,
      in_flight_state: 'active',
    });

    expect(repairCollectionVersion(db, { processorSubscriptionId: 'sub_repair', now: 3 })).toEqual({
      repaired: false,
      desiredVersion: 1,
      inFlightState: 'active',
    });

    cancelCollection(db, { processorSubscriptionId: 'sub_repair', now: 4 });
    expect(repairCollectionVersion(db, { processorSubscriptionId: 'sub_repair', now: 5 })).toEqual({
      repaired: false,
      desiredVersion: 2,
      inFlightState: null,
    });
  });

  it('records one grace-expiry audit per subscription deadline', () => {
    const accountId = account('billing-grace-audit');

    expect(
      recordGraceExpiryAudit(db, {
        accountId,
        processorSubscriptionId: 'sub_grace',
        graceUntil: 5_000,
        now: 5_001,
      }),
    ).toEqual({ recorded: true });
    expect(
      recordGraceExpiryAudit(db, {
        accountId,
        processorSubscriptionId: 'sub_grace',
        graceUntil: 5_000,
        now: 9_000,
      }),
    ).toEqual({ recorded: false });

    expect(auditRows(db)).toEqual([
      {
        auditId: expect.any(String),
        subjectKind: 'account',
        subjectId: accountId,
        action: 'entitlement_change',
        causeKind: 'grace_expiry',
        causeId: 'sub_grace:5000',
        actor: 'system:reconcile',
        reason: 'grace deadline passed',
        previousPlan: null,
        nextPlan: null,
        previousStatus: 'past_due',
        nextStatus: 'past_due',
        processorEventId: null,
        createdAt: 5_001,
      },
    ]);
  });

  it('reads the billing sweep watermark before and after recording', () => {
    expect(readBillingSweep(db, 'disputes')).toBeNull();
    expect(recordBillingSweep(db, { kind: 'disputes', lastSweptAt: 100, now: 10 })).toEqual({
      recorded: true,
    });
    expect(readBillingSweep(db, 'disputes')).toEqual({ lastSweptAt: 100, updatedAt: 10 });
    expect(recordBillingSweep(db, { kind: 'disputes', lastSweptAt: 50, now: 20 })).toEqual({
      recorded: false,
    });
    expect(recordBillingSweep(db, { kind: 'disputes', lastSweptAt: 200, now: 30 })).toEqual({
      recorded: true,
    });
    expect(readBillingSweep(db, 'disputes')).toEqual({ lastSweptAt: 200, updatedAt: 30 });
  });

  it('records the first paid moment exactly once', () => {
    attach('co-first-paid', 'sub_first_paid', 'active');

    expect(
      setCompanyFirstPaidAt(db, { processorSubscriptionId: 'sub_first_paid', occurredAt: 5_000 }),
    ).toEqual({ updated: true });
    expect(
      setCompanyFirstPaidAt(db, { processorSubscriptionId: 'sub_first_paid', occurredAt: 6_000 }),
    ).toEqual({ updated: false });
    expect(
      db
        .prepare(
          `SELECT first_paid_at AS firstPaidAt FROM company_subscriptions
           WHERE processor_subscription_id = 'sub_first_paid'`,
        )
        .get(),
    ).toEqual({ firstPaidAt: 5_000 });
    expect(
      setCompanyFirstPaidAt(db, {
        processorSubscriptionId: 'sub_first_paid_other',
        occurredAt: 6_000,
      }),
    ).toEqual({ updated: false });
  });

  it('pseudonymizes entitlement audit subjects for one erased account', () => {
    const erasedId = account('billing-erasure');
    const keptId = account('billing-erasure-kept');
    writeEntitlement(
      db,
      { accountId: erasedId, source: 'personal', state: entitlingState(), now: 1 },
      cause('operator', 'op_erasure'),
    );
    writeEntitlement(
      db,
      { accountId: keptId, source: 'personal', state: entitlingState(), now: 2 },
      cause('operator', 'op_kept'),
    );

    expect(
      pseudonymizeEntitlementAuditSubject(db, {
        accountId: erasedId,
        pseudonym: 'erased-pseudonym',
      }),
    ).toBe(1);
    expect(
      pseudonymizeEntitlementAuditSubject(db, {
        accountId: erasedId,
        pseudonym: 'erased-pseudonym',
      }),
    ).toBe(0);
    expect(
      db.prepare(`SELECT subject_id AS subjectId FROM entitlement_audit ORDER BY created_at`).all(),
    ).toEqual([{ subjectId: 'erased-pseudonym' }, { subjectId: keptId }]);
  });

  it('records the processor event id when a company row is deleted by processor cause', () => {
    const companyId = 'co-delete-processor';
    company(companyId);
    const memberId = account('delete-processor-member');
    writeEntitlement(
      db,
      {
        accountId: memberId,
        source: 'company',
        state: entitlingState({ planId: 'corporate_seat', companyId }),
        now: 10,
      },
      cause('membership', 'seed-processor-delete'),
    );

    expect(
      deleteCompanyEntitlement(db, {
        companyId,
        accountId: memberId,
        cause: cause('processor_event', 'evt-delete-processor'),
        now: 20,
      }),
    ).toEqual({ deleted: true });
    expect(auditRows(db).filter((row) => row.causeId === 'evt-delete-processor')).toEqual([
      expect.objectContaining({
        causeKind: 'processor_event',
        processorEventId: 'evt-delete-processor',
      }),
    ]);
  });

  it('refuses to record a non-operator cause as an operator action', () => {
    const refuse = () =>
      recordOperatorAction(db, {
        subjectKind: 'account',
        subjectId: 'acc-not-operator',
        cause: cause('membership', 'invite-not-operator'),
        now: 1,
      });
    expect(refuse).toThrow(IdentityInputError);
    expect(refuse).toThrow('operator cause required');
    expect(auditRows(db)).toEqual([]);
  });

  it('applies a state replay carrying the same event creation timestamp', () => {
    const accountId = account('billing-apply-replay');
    const apply = (
      status: 'active' | 'canceled',
      canceledAt: number | null,
      causeId: string,
    ) =>
      applySubscriptionState(
        db,
        {
          processorSubscriptionId: 'sub_apply_replay',
          accountId,
          planId: 'tutor_pro_monthly',
          processorCustomerId: 'cus_billing',
          eventCreated: 100,
          now: 100,
          fetched: { status, currentPeriodEnd: null, canceledAt, pauseCollection: false },
        },
        cause('processor_event', causeId),
      );

    expect(apply('active', null, 'evt_replay_first')).toEqual({
      applied: true,
      canceledNow: false,
    });
    expect(apply('canceled', 150, 'evt_replay_second')).toEqual({
      applied: true,
      canceledNow: true,
    });
    expect(entitlement(accountId)?.status).toBe('canceled');
  });

  it('applies a company state replay carrying the same event creation timestamp', () => {
    attach('co-company-replay', 'sub_company_replay', 'trialing');
    expect(
      applyCompany('sub_company_replay', 'co-company-replay', 900, {
        status: 'active',
        currentPeriodEnd: null,
        canceledAt: null,
        pauseCollection: false,
      }),
    ).toEqual({ applied: true, canceledNow: false });

    expect(
      applyCompany('sub_company_replay', 'co-company-replay', 900, {
        status: 'canceled',
        currentPeriodEnd: null,
        canceledAt: 950,
        pauseCollection: false,
      }),
    ).toEqual({ applied: true, canceledNow: true });
    expect(companySubscription('sub_company_replay')?.status).toBe('canceled');
  });

  it('treats a repeated dispute state as unchanged', () => {
    ensure('sub_hold_replay', account('billing-hold-replay'));
    expect(
      upsertDisputeHold(db, {
        disputeId: 'dp_hold_replay',
        processorSubscriptionId: 'sub_hold_replay',
        state: 'review',
        now: 1,
      }),
    ).toEqual({ stateChanged: true, state: 'review' });

    expect(
      upsertDisputeHold(db, {
        disputeId: 'dp_hold_replay',
        processorSubscriptionId: 'sub_hold_replay',
        state: 'review',
        now: 2,
      }),
    ).toEqual({ stateChanged: false, state: 'review' });
  });

  it('never projects a company ordering row onto an account entitlement', () => {
    const accountId = account('billing-company-projection');
    writeEntitlement(
      db,
      { accountId, source: 'personal', state: entitlingState(), now: 5 },
      cause('operator', 'op_company_projection'),
    );
    ensureBillingSubscription(db, {
      processorSubscriptionId: 'sub_company_projection',
      subjectKind: 'company',
      subjectId: accountId,
      now: 6,
    });
    upsertDisputeHold(db, {
      disputeId: 'dp_company_projection',
      processorSubscriptionId: 'sub_company_projection',
      state: 'open',
      now: 7,
    });

    expect(
      recomputeDesiredCollection(db, {
        processorSubscriptionId: 'sub_company_projection',
        cause: cause('reconcile', 'rc_company_projection'),
        now: 8,
      }),
    ).toEqual({ changed: true, desired: 'paused' });
    expect(entitlement(accountId)).toMatchObject({ collection_paused: 0 });
    expect(auditRows(db).filter((row) => row.causeId === 'rc_company_projection')).toEqual([]);
  });

  it('resumes collection on the member entitlement when a dispute resolves', () => {
    const accountId = account('billing-recompute-resume');
    writeEntitlement(
      db,
      { accountId, source: 'personal', state: entitlingState(), now: 5 },
      cause('operator', 'op_recompute_resume'),
    );
    ensure('sub_recompute_resume', accountId);
    upsertDisputeHold(db, {
      disputeId: 'dp_recompute_resume',
      processorSubscriptionId: 'sub_recompute_resume',
      state: 'open',
      now: 6,
    });
    expect(
      recomputeDesiredCollection(db, {
        processorSubscriptionId: 'sub_recompute_resume',
        cause: cause('reconcile', 'rc_resume_pause'),
        now: 7,
      }),
    ).toEqual({ changed: true, desired: 'paused' });
    expect(entitlement(accountId)).toMatchObject({ collection_paused: 1 });

    upsertDisputeHold(db, {
      disputeId: 'dp_recompute_resume',
      processorSubscriptionId: 'sub_recompute_resume',
      state: 'won',
      now: 8,
    });
    expect(
      recomputeDesiredCollection(db, {
        processorSubscriptionId: 'sub_recompute_resume',
        cause: cause('reconcile', 'rc_resume_active'),
        now: 9,
      }),
    ).toEqual({ changed: true, desired: 'active' });
    expect(entitlement(accountId)).toMatchObject({ collection_paused: 0 });
  });

  it('settles a claim when no expected version was supplied', () => {
    const accountId = account('billing-settle-no-version');
    ensure('sub_settle_no_version', accountId);
    upsertDisputeHold(db, {
      disputeId: 'dp_settle_no_version',
      processorSubscriptionId: 'sub_settle_no_version',
      state: 'open',
      now: 1,
    });
    recomputeDesiredCollection(db, {
      processorSubscriptionId: 'sub_settle_no_version',
      cause: cause('reconcile', 'rc_settle_no_version'),
      now: 2,
    });
    claimCollection(db, { processorSubscriptionId: 'sub_settle_no_version', now: 3 });

    expect(
      settleCollectionSuccess(db, {
        processorSubscriptionId: 'sub_settle_no_version',
        expectedVersion: undefined,
        now: 4,
      }),
    ).toEqual({ settled: true, reason: 'ok' });
  });

  it('clears a failed claim when no expected version was supplied', () => {
    const accountId = account('billing-failure-no-version');
    ensure('sub_failure_no_version', accountId);
    upsertDisputeHold(db, {
      disputeId: 'dp_failure_no_version',
      processorSubscriptionId: 'sub_failure_no_version',
      state: 'open',
      now: 1,
    });
    recomputeDesiredCollection(db, {
      processorSubscriptionId: 'sub_failure_no_version',
      cause: cause('reconcile', 'rc_failure_no_version'),
      now: 2,
    });
    claimCollection(db, { processorSubscriptionId: 'sub_failure_no_version', now: 3 });

    expect(
      settleCollectionFailure(db, {
        processorSubscriptionId: 'sub_failure_no_version',
        expectedVersion: undefined,
        now: 4,
      }),
    ).toEqual({ cleared: true, reason: 'ok' });
  });
});
