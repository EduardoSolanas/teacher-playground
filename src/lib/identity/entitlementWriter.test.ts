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
import { readEntitlementsForAccount, writeEntitlement } from './entitlementWriter';
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
