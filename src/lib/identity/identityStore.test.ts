import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  IdentityInputError,
  TUTOR_ACCOUNT_CAP_DEFAULT,
  applyIdentitySchema,
  isTutorCapReached,
  resolveAccountForSubject,
  readAccountAuthorizations,
  recordOwnedRoom,
  listOwnedRooms,
  removeOwnedRoom,
  readPreferredDisplayName,
  setPreferredDisplayName,
  createGuestAccount,
} from './identityStore';
import { applySchema as applyRoomSchema } from '../whiteboard/roomSchema';

function resolveStoredAccount(
  db: Database.Database,
  input: { issuer: string; subject: string },
) {
  const outcome = resolveAccountForSubject(db, input);
  if (isTutorCapReached(outcome)) {
    throw new Error('unexpected tutor cap outcome');
  }
  return outcome;
}

describe('authoritative identity store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('creates only the global account, subject, session, and audit tables', () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual([
      'access_subjects',
      'account_rooms',
      'accounts',
      'authorization_audit',
      'billing_dispute_holds',
      'billing_effects',
      'billing_events',
      'billing_operations',
      'billing_payments',
      'billing_subscriptions',
      'billing_sweeps',
      'companies',
      'company_invites',
      'company_members',
      'company_subscriptions',
      'entitlement_audit',
      'entitlements',
      'pending_erasures',
      'referral_codes',
      'referral_events',
      'sessions',
    ]);

    const identityTables = tables.filter(
      (table) => table !== 'account_rooms' && table !== 'companies',
    );
    const columns = identityTables.flatMap((table) =>
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name),
    );
    for (const forbidden of [
      'email',
      'name',
      'user_name',
      'provider',
      'provider_label',
    ]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('does not duplicate global identity tables in a room database', () => {
    const roomDb = new Database(':memory:');
    applyRoomSchema(roomDb);
    const tables = roomDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).not.toContain('accounts');
    expect(tables).not.toContain('access_subjects');
    expect(tables).not.toContain('sessions');
  });

  it('can safely apply initialization more than once', () => {
    expect(() => applyIdentitySchema(db)).not.toThrow();
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM accounts`).get(),
    ).toEqual({ count: 0 });
  });

  it('maps an exact issuer and subject to one opaque account', () => {
    const first = resolveStoredAccount(db, {
      issuer: 'https://access.example.com',
      subject: 'google-subject-1',
    });
    const second = resolveStoredAccount(db, {
      issuer: 'https://access.example.com',
      subject: 'google-subject-1',
    });

    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect(first.account.accountId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM accounts`).get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM access_subjects`).get(),
    ).toEqual({ count: 1 });
    expect(() =>
      db
        .prepare(
          `INSERT INTO access_subjects (issuer, subject, account_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          'https://access.example.com',
          'google-subject-1',
          first.account.accountId,
          Date.now(),
        ),
    ).toThrow(/UNIQUE constraint/);
  });

  it('does not link distinct subjects through email or provider labels', () => {
    const first = resolveStoredAccount(db, {
      issuer: 'https://access.example.com',
      subject: 'google-subject',
    });
    const second = resolveStoredAccount(db, {
      issuer: 'https://access.example.com',
      subject: 'facebook-subject',
    });

    expect(second.account.accountId).not.toBe(first.account.accountId);
    const subjectColumns = db
      .prepare(`PRAGMA table_info(access_subjects)`)
      .all()
      .map((row) => (row as { name: string }).name);
    expect(subjectColumns).not.toContain('email');
    expect(subjectColumns).not.toContain('provider');
    expect(subjectColumns).not.toContain('provider_label');
  });

  it('stores account disablement and authorization epoch centrally', () => {
    const resolved = resolveStoredAccount(db, {
      issuer: 'issuer',
      subject: 'subject',
    });

    db.prepare(
      `UPDATE accounts
       SET state = 'disabled', authorization_epoch = 4, updated_at = ?
       WHERE account_id = ?`,
    ).run(Date.now(), resolved.account.accountId);

    expect(
      db
        .prepare(
          `SELECT state, authorization_epoch AS authorizationEpoch
           FROM accounts WHERE account_id = ?`,
        )
        .get(resolved.account.accountId),
    ).toEqual({ state: 'disabled', authorizationEpoch: 4 });
  });

  it('stores only a hashed session identifier and cascades account deletion', () => {
    const resolved = resolveStoredAccount(db, {
      issuer: 'issuer',
      subject: 'subject',
    });
    const hash = 'a'.repeat(64);
    db.prepare(
      `INSERT INTO sessions (
         session_hash, account_id, authorization_epoch,
         created_at, last_seen_at, idle_expires_at,
         absolute_expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(hash, resolved.account.accountId, 0, 100, 100, 150, 200);

    const sessionColumns = db
      .prepare(`PRAGMA table_info(sessions)`)
      .all()
      .map((row) => (row as { name: string }).name);
    expect(sessionColumns).toEqual([
      'session_hash',
      'account_id',
      'authorization_epoch',
      'created_at',
      'last_seen_at',
      'idle_expires_at',
      'absolute_expires_at',
      'revoked_at',
      'confirmed_at',
    ]);
    expect(sessionColumns).not.toContain('token');
    expect(sessionColumns).not.toContain('email');

    db.prepare(`DELETE FROM accounts WHERE account_id = ?`).run(
      resolved.account.accountId,
    );
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM access_subjects`).get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get(),
    ).toEqual({ count: 0 });
  });

  it('enforces session account foreign keys and valid account state/epochs', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO sessions (
             session_hash, account_id, authorization_epoch,
             created_at, last_seen_at, idle_expires_at, absolute_expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('b'.repeat(64), 'missing', 0, 100, 100, 150, 200),
    ).toThrow(/FOREIGN KEY/);

    const resolved = resolveStoredAccount(db, {
      issuer: 'issuer',
      subject: 'hash-check',
    });
    expect(() =>
      db
        .prepare(
          `INSERT INTO sessions (
             session_hash, account_id, authorization_epoch,
             created_at, last_seen_at, idle_expires_at, absolute_expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('Z'.repeat(64), resolved.account.accountId, 0, 100, 100, 150, 200),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      db
        .prepare(
          `INSERT INTO accounts (
             account_id, state, authorization_epoch, created_at, updated_at
           ) VALUES (?, 'other', 0, 1, 1)`,
        )
        .run('bad-state'),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      db
        .prepare(
          `INSERT INTO accounts (
             account_id, state, authorization_epoch, created_at, updated_at
           ) VALUES (?, 'active', -1, 1, 1)`,
        )
        .run('bad-epoch'),
    ).toThrow(/CHECK constraint/);
  });

  it.each([
    { issuer: '', subject: 'subject' },
    { issuer: '   ', subject: 'subject' },
    { issuer: 'issuer', subject: '' },
    { issuer: 'issuer', subject: '\t' },
    { issuer: 'i'.repeat(2049), subject: 'subject' },
    { issuer: 'issuer', subject: 's'.repeat(2049) },
  ])('rejects invalid or unbounded subject keys: %o', (input) => {
    expect(() => resolveAccountForSubject(db, input)).toThrow(
      IdentityInputError,
    );
  });
});

describe('account authorization lookup for live connections', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function account(issuer: string, subject: string) {
    return resolveStoredAccount(db, { issuer, subject }).account;
  }

  it('reports current state and epoch for the requested accounts only', () => {
    const first = account('https://issuer', 'subject-a');
    const second = account('https://issuer', 'subject-b');
    account('https://issuer', 'subject-c');

    const statuses = readAccountAuthorizations(db, [
      first.accountId,
      second.accountId,
    ]);

    expect(statuses.size).toBe(2);
    expect(statuses.get(first.accountId)).toEqual({
      state: 'active',
      authorizationEpoch: first.authorizationEpoch,
    });
    expect(statuses.get(second.accountId)).toEqual({
      state: 'active',
      authorizationEpoch: second.authorizationEpoch,
    });
  });

  it('reflects a disabled account and an advanced epoch', () => {
    const target = account('https://issuer', 'subject-a');

    db.prepare(
      `UPDATE accounts
       SET state = 'disabled', authorization_epoch = authorization_epoch + 1,
           updated_at = updated_at + 1
       WHERE account_id = ?`,
    ).run(target.accountId);

    expect(readAccountAuthorizations(db, [target.accountId]).get(target.accountId)).toEqual({
      state: 'disabled',
      authorizationEpoch: target.authorizationEpoch + 1,
    });
  });

  it('omits unknown accounts rather than inventing an authorized answer', () => {
    const known = account('https://issuer', 'subject-a');

    const statuses = readAccountAuthorizations(db, [known.accountId, 'no-such-account']);

    expect(statuses.has('no-such-account')).toBe(false);
    expect(statuses.has(known.accountId)).toBe(true);
  });

  it('returns nothing for an empty request and de-duplicates repeats', () => {
    const known = account('https://issuer', 'subject-a');

    expect(readAccountAuthorizations(db, []).size).toBe(0);
    expect(
      readAccountAuthorizations(db, [known.accountId, known.accountId]).size,
    ).toBe(1);
  });

  it('rejects unbounded batches instead of building an unbounded query', () => {
    expect(() =>
      readAccountAuthorizations(
        db,
        Array.from({ length: 501 }, (_, index) => `account-${index}`),
      ),
    ).toThrow(IdentityInputError);
  });
});

describe('account owned-room index', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function account(subject: string) {
    return resolveStoredAccount(db, {
      issuer: 'https://issuer',
      subject,
    }).account;
  }

  it('lists an empty array when the account owns no rooms', () => {
    const owner = account('owner-empty');
    expect(listOwnedRooms(db, owner.accountId)).toEqual([]);
  });

  // Naming became the teacher's own choice, so a stored name is now theirs to
  // lose. recordOwnedRoom upserts with `name = excluded.name`, and the
  // room-creation path calls it with name: null — so any nameless re-sync of an
  // already-named room silently erases the name the teacher typed.
  it('a nameless re-sync does not erase a name the teacher set', () => {
    const owner = account('owner-rename');
    recordOwnedRoom(db, {
      accountId: owner.accountId,
      roomId: 'room-keep',
      name: 'Tuesday algebra',
      now: 1_000,
    });

    recordOwnedRoom(db, {
      accountId: owner.accountId,
      roomId: 'room-keep',
      name: null,
      now: 2_000,
    });

    const [room] = listOwnedRooms(db, owner.accountId);
    expect(room.name).toBe('Tuesday algebra');
  });

  it('records two rooms and lists newest updated first', () => {
    const owner = account('owner-two');
    recordOwnedRoom(db, {
      accountId: owner.accountId,
      roomId: 'room-older',
      name: 'Older',
      now: 1_000,
    });
    recordOwnedRoom(db, {
      accountId: owner.accountId,
      roomId: 'room-newer',
      name: 'Newer',
      now: 2_000,
    });

    expect(listOwnedRooms(db, owner.accountId)).toEqual([
      {
        roomId: 'room-newer',
        name: 'Newer',
        role: 'owner',
        createdAt: 2_000,
        updatedAt: 2_000,
      },
      {
        roomId: 'room-older',
        name: 'Older',
        role: 'owner',
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ]);
  });

  it('does not list rooms owned by another account', () => {
    const mine = account('owner-mine');
    const other = account('owner-other');
    recordOwnedRoom(db, {
      accountId: other.accountId,
      roomId: 'secret-room',
      name: 'Secret',
      now: 1_000,
    });

    expect(listOwnedRooms(db, mine.accountId)).toEqual([]);
    expect(listOwnedRooms(db, other.accountId)).toEqual([
      expect.objectContaining({ roomId: 'secret-room' }),
    ]);
  });

  it('upserts name and updated_at while keeping created_at', () => {
    const owner = account('owner-upsert');
    recordOwnedRoom(db, {
      accountId: owner.accountId,
      roomId: 'same-room',
      name: 'First',
      now: 1_000,
    });
    recordOwnedRoom(db, {
      accountId: owner.accountId,
      roomId: 'same-room',
      name: 'Second',
      now: 3_000,
    });

    expect(listOwnedRooms(db, owner.accountId)).toEqual([
      {
        roomId: 'same-room',
        name: 'Second',
        role: 'owner',
        createdAt: 1_000,
        updatedAt: 3_000,
      },
    ]);
  });

  it('removes an owned room without affecting other rows', () => {
    const owner = account('owner-remove');
    recordOwnedRoom(db, {
      accountId: owner.accountId,
      roomId: 'keep-me',
      name: null,
      now: 1_000,
    });
    recordOwnedRoom(db, {
      accountId: owner.accountId,
      roomId: 'drop-me',
      name: 'Gone',
      now: 2_000,
    });
    removeOwnedRoom(db, owner.accountId, 'drop-me');

    expect(listOwnedRooms(db, owner.accountId)).toEqual([
      expect.objectContaining({ roomId: 'keep-me' }),
    ]);
  });

  it('stores a preferred display name on the account without using it as a lookup key', () => {
    const first = resolveStoredAccount(db, {
      issuer: 'https://access.example.com',
      subject: 'google-one',
    });
    const second = resolveStoredAccount(db, {
      issuer: 'https://access.example.com',
      subject: 'google-two',
    });

    expect(readPreferredDisplayName(db, first.account.accountId)).toBeNull();
    expect(setPreferredDisplayName(db, first.account.accountId, 'Ada Lovelace')).toBe(
      'Ada Lovelace',
    );
    expect(readPreferredDisplayName(db, first.account.accountId)).toBe('Ada Lovelace');
    expect(readPreferredDisplayName(db, second.account.accountId)).toBeNull();

    const sameNameOtherSubject = resolveStoredAccount(db, {
      issuer: 'https://access.example.com',
      subject: 'google-three',
    });
    expect(sameNameOtherSubject.account.accountId).not.toBe(first.account.accountId);
    setPreferredDisplayName(db, sameNameOtherSubject.account.accountId, 'Ada Lovelace');
    expect(sameNameOtherSubject.account.accountId).not.toBe(first.account.accountId);

    const accountColumns = db
      .prepare(`PRAGMA table_info(accounts)`)
      .all()
      .map((row) => (row as { name: string }).name);
    expect(accountColumns).toContain('preferred_display_name');
    expect(accountColumns).not.toContain('email');
  });
});

describe('guest accounts', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('applyIdentitySchema adds provenance and guest_room_id columns to accounts table', () => {
    const accountColumns = db
      .prepare(`PRAGMA table_info(accounts)`)
      .all()
      .map((row) => (row as { name: string }).name);

    expect(accountColumns).toContain('provenance');
    expect(accountColumns).toContain('guest_room_id');
  });

  it('migrates legacy accounts table by adding provenance and guest_room_id columns', () => {
    // Create a legacy accounts table WITHOUT the new columns (simulating pre-migration DB)
    db.exec(`
      CREATE TABLE legacy_accounts (
        account_id TEXT PRIMARY KEY
          CHECK (length(account_id) BETWEEN 1 AND 128),
        state TEXT NOT NULL DEFAULT 'active'
          CHECK (state IN ('active', 'disabled')),
        authorization_epoch INTEGER NOT NULL DEFAULT 0
          CHECK (authorization_epoch >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
          CHECK (updated_at >= created_at)
      )
    `);

    // Drop the auto-created accounts table and rename legacy_accounts
    db.exec(`DROP TABLE company_members`);
    db.exec(`DROP TABLE accounts`);
    db.exec(`ALTER TABLE legacy_accounts RENAME TO accounts`);

    // Insert a row into the legacy table
    db.prepare(
      `INSERT INTO accounts (account_id, state, authorization_epoch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('legacy-account', 'active', 0, 1000, 1000);

    // Apply schema (should migrate)
    applyIdentitySchema(db);

    // Verify columns exist
    const columns = db
      .prepare(`PRAGMA table_info(accounts)`)
      .all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain('provenance');
    expect(columns.map((c) => c.name)).toContain('guest_room_id');

    // Verify existing row migrated correctly
    const row = db
      .prepare(
        `SELECT provenance, guest_room_id FROM accounts WHERE account_id = ?`,
      )
      .get('legacy-account') as { provenance: string; guest_room_id: string | null };

    expect(row.provenance).toBe('access');
    expect(row.guest_room_id).toBeNull();
  });

  it('applyIdentitySchema is idempotent on migrated databases', () => {
    // Create a legacy table as above
    db.exec(`
      CREATE TABLE legacy_accounts (
        account_id TEXT PRIMARY KEY
          CHECK (length(account_id) BETWEEN 1 AND 128),
        state TEXT NOT NULL DEFAULT 'active'
          CHECK (state IN ('active', 'disabled')),
        authorization_epoch INTEGER NOT NULL DEFAULT 0
          CHECK (authorization_epoch >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
          CHECK (updated_at >= created_at)
      )
    `);
    db.exec(`DROP TABLE company_members`);
    db.exec(`DROP TABLE accounts`);
    db.exec(`ALTER TABLE legacy_accounts RENAME TO accounts`);

    // Apply schema twice
    expect(() => applyIdentitySchema(db)).not.toThrow();
    expect(() => applyIdentitySchema(db)).not.toThrow();

    // Table should still be valid
    const columns = db
      .prepare(`PRAGMA table_info(accounts)`)
      .all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain('provenance');
    expect(columns.map((c) => c.name)).toContain('guest_room_id');
  });

  it('NEGATIVE: triggers reject invalid provenance/guest_room_id on migrated database', () => {
    // Create and migrate a legacy table
    db.exec(`
      CREATE TABLE legacy_accounts (
        account_id TEXT PRIMARY KEY
          CHECK (length(account_id) BETWEEN 1 AND 128),
        state TEXT NOT NULL DEFAULT 'active'
          CHECK (state IN ('active', 'disabled')),
        authorization_epoch INTEGER NOT NULL DEFAULT 0
          CHECK (authorization_epoch >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
          CHECK (updated_at >= created_at)
      )
    `);
    db.exec(`DROP TABLE company_members`);
    db.exec(`DROP TABLE accounts`);
    db.exec(`ALTER TABLE legacy_accounts RENAME TO accounts`);

    // Apply schema to migrate
    applyIdentitySchema(db);

    // Try to insert provenance='guest' with NULL guest_room_id - should fail via trigger
    expect(() => {
      db.prepare(
        `INSERT INTO accounts (
           account_id, state, authorization_epoch, created_at, updated_at,
           provenance, guest_room_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('bad-guest-migrated', 'active', 0, 1000, 1000, 'guest', null);
    }).toThrow(/invalid provenance/);
  });

  it('createGuestAccount creates an account with provenance=guest and the given guest_room_id', () => {
    const account = createGuestAccount(db, { roomId: 'test-room-123', now: 2000 });

    expect(account.state).toBe('active');
    expect(account.authorizationEpoch).toBe(0);
    expect(account.createdAt).toBe(2000);
    expect(account.updatedAt).toBe(2000);
    expect(account.accountId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const row = db
      .prepare(
        `SELECT provenance, guest_room_id FROM accounts WHERE account_id = ?`,
      )
      .get(account.accountId) as { provenance: string; guest_room_id: string };

    expect(row.provenance).toBe('guest');
    expect(row.guest_room_id).toBe('test-room-123');
  });

  it('NEGATIVE: inserting provenance=guest with NULL guest_room_id is rejected by trigger', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO accounts (
           account_id, state, authorization_epoch, created_at, updated_at,
           provenance, guest_room_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('bad-guest', 'active', 0, 1000, 1000, 'guest', null);
    }).toThrow(/invalid provenance/);
  });

  it('NEGATIVE: inserting provenance=access with non-NULL guest_room_id is rejected by trigger', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO accounts (
           account_id, state, authorization_epoch, created_at, updated_at,
           provenance, guest_room_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('bad-access', 'active', 0, 1000, 1000, 'access', 'some-room');
    }).toThrow(/invalid provenance/);
  });

  it('NEGATIVE: inserting unrecognized provenance value is rejected by trigger', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO accounts (
           account_id, state, authorization_epoch, created_at, updated_at,
           provenance, guest_room_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('bad-provenance', 'active', 0, 1000, 1000, 'admin', null);
    }).toThrow(/invalid provenance/);
  });

  it('NEGATIVE: resolveAccountForSubject never returns a guest account', () => {
    // First create an access account through the normal path
    const accessAccount = resolveStoredAccount(db, {
      issuer: 'https://access.example.com',
      subject: 'google-subject-1',
    });

    // Manually insert a guest account (once the columns exist)
    db.prepare(
      `INSERT INTO accounts (
         account_id, state, authorization_epoch, created_at, updated_at,
         provenance, guest_room_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('guest-account-123', 'active', 0, 1000, 1000, 'guest', 'room-xyz');

    // Now call resolveAccountForSubject with arbitrary issuer/subject
    const newAccount = resolveStoredAccount(db, {
      issuer: 'https://access.example.com',
      subject: 'google-subject-2',
    });

    // Should create a NEW account, not return or mutate the guest account
    expect(newAccount.account.accountId).not.toBe('guest-account-123');
    expect(newAccount.created).toBe(true);

    // Verify the guest account is still there and unchanged
    const guestRow = db
      .prepare(
        `SELECT provenance, guest_room_id FROM accounts WHERE account_id = ?`,
      )
      .get('guest-account-123') as { provenance: string; guest_room_id: string };
    expect(guestRow.provenance).toBe('guest');
    expect(guestRow.guest_room_id).toBe('room-xyz');
  });

  it('NEGATIVE: guest account is not reachable through access_subjects path', () => {
    // Create a guest account directly
    db.prepare(
      `INSERT INTO accounts (
         account_id, state, authorization_epoch, created_at, updated_at,
         provenance, guest_room_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('guest-account-456', 'active', 0, 1000, 1000, 'guest', 'room-abc');

    // Try to find it via the access_subjects path
    const foundBySubject = db
      .prepare(
        `SELECT a.account_id FROM access_subjects s
         JOIN accounts a ON a.account_id = s.account_id
         WHERE a.account_id = ?`,
      )
      .get('guest-account-456');

    expect(foundBySubject).toBeUndefined();
  });
});

describe('Phase 1 identity schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function accessAccount(subject: string): string {
    return resolveStoredAccount(db, {
      issuer: 'https://issuer',
      subject,
    }).account.accountId;
  }

  function insertCompany(companyId: string): void {
    db.prepare(
      `INSERT INTO companies (company_id, name, created_at, updated_at)
       VALUES (?, ?, 1, 1)`,
    ).run(companyId, `Company ${companyId}`);
  }

  function insertEntitlement(input: {
    accountId: string;
    source: 'personal' | 'company';
    planId: string;
    status: string;
    graceUntil?: number | null;
    companyId?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO entitlements (
         account_id, source, plan_id, status, grace_until, company_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      input.accountId,
      input.source,
      input.planId,
      input.status,
      input.graceUntil ?? null,
      input.companyId ?? null,
    );
  }

  function insertMember(input: {
    companyId: string;
    accountId: string;
    role: 'owner' | 'admin' | 'member';
    state: 'active' | 'revoked';
    createdAt?: number;
    revokedAt?: number | null;
  }): void {
    db.prepare(
      `INSERT INTO company_members (
         company_id, account_id, role, state, created_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.companyId,
      input.accountId,
      input.role,
      input.state,
      input.createdAt ?? 1,
      input.revokedAt ?? null,
    );
  }

  function insertInvite(input: {
    inviteHash: string;
    companyId: string;
    createdBy: string;
    expiresAt: number;
    role?: 'admin' | 'member';
    redeemedBy?: string | null;
    redeemedAt?: number | null;
    revokedAt?: number | null;
    createdAt?: number;
  }): void {
    db.prepare(
      `INSERT INTO company_invites (
         invite_hash, company_id, role, created_by, expires_at,
         redeemed_by, redeemed_at, revoked_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.inviteHash,
      input.companyId,
      input.role ?? 'member',
      input.createdBy,
      input.expiresAt,
      input.redeemedBy ?? null,
      input.redeemedAt ?? null,
      input.revokedAt ?? null,
      input.createdAt ?? 1,
    );
  }

  function insertEntitlementAudit(input: {
    auditId: string;
    subjectId: string;
    causeKind: 'processor_event' | 'membership';
    causeId: string;
    processorEventId?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO entitlement_audit (
         audit_id, subject_kind, subject_id, action, cause_kind, cause_id,
         actor, reason, processor_event_id, created_at
       ) VALUES (?, 'account', ?, 'grant', ?, ?, 'tester', 'phase 1 test', ?, 1)`,
    ).run(
      input.auditId,
      input.subjectId,
      input.causeKind,
      input.causeId,
      input.processorEventId ?? null,
    );
  }

  it('creates every Phase 1 billing and membership table', () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'billing_dispute_holds',
        'billing_effects',
        'billing_events',
        'billing_operations',
        'billing_payments',
        'billing_subscriptions',
        'billing_sweeps',
        'companies',
        'company_invites',
        'company_members',
        'company_subscriptions',
        'entitlement_audit',
        'entitlements',
        'referral_codes',
        'referral_events',
      ]),
    );
  });

  it('keys entitlements by account and source', () => {
    const accountId = accessAccount('entitlement-pk');
    insertCompany('company-pk');
    insertEntitlement({
      accountId,
      source: 'personal',
      planId: 'free',
      status: 'free',
    });
    insertEntitlement({
      accountId,
      source: 'company',
      planId: 'corporate_seat',
      status: 'active',
      companyId: 'company-pk',
    });
    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM entitlements WHERE account_id = ?`)
        .get(accountId),
    ).toEqual({ count: 2 });

    expect(() =>
      insertEntitlement({
        accountId,
        source: 'personal',
        planId: 'free',
        status: 'free',
      }),
    ).toThrow(/UNIQUE constraint/);
  });

  it('enforces entitlement status, plan, and company constraints', () => {
    const accountId = accessAccount('entitlement-checks');
    insertCompany('company-checks');

    expect(() =>
      insertEntitlement({
        accountId,
        source: 'personal',
        planId: 'free',
        status: 'past_due',
      }),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      insertEntitlement({
        accountId,
        source: 'personal',
        planId: 'free',
        status: 'active',
        graceUntil: 100,
      }),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      insertEntitlement({
        accountId,
        source: 'personal',
        planId: 'platinum',
        status: 'active',
      }),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      insertEntitlement({
        accountId,
        source: 'company',
        planId: 'corporate_seat',
        status: 'active',
      }),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      insertEntitlement({
        accountId,
        source: 'company',
        planId: 'corporate_seat',
        status: 'active',
        companyId: 'no-such-company',
      }),
    ).toThrow(/FOREIGN KEY/);
  });

  it('allows at most one active membership per account', () => {
    const accountId = accessAccount('membership-active');
    insertCompany('company-a');
    insertCompany('company-b');
    insertMember({
      companyId: 'company-a',
      accountId,
      role: 'owner',
      state: 'active',
    });

    expect(() =>
      insertMember({
        companyId: 'company-b',
        accountId,
        role: 'member',
        state: 'active',
      }),
    ).toThrow(/UNIQUE constraint/);

    insertMember({
      companyId: 'company-b',
      accountId,
      role: 'member',
      state: 'revoked',
      revokedAt: 5,
    });
    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM company_members WHERE account_id = ?`)
        .get(accountId),
    ).toEqual({ count: 2 });
  });

  it('allows at most one active owner per company', () => {
    const firstOwner = accessAccount('owner-index-one');
    const secondOwner = accessAccount('owner-index-two');
    insertCompany('company-owner');
    insertMember({
      companyId: 'company-owner',
      accountId: firstOwner,
      role: 'owner',
      state: 'active',
    });

    expect(() =>
      insertMember({
        companyId: 'company-owner',
        accountId: secondOwner,
        role: 'owner',
        state: 'active',
      }),
    ).toThrow(/UNIQUE constraint/);
  });

  it('requires an access-provenance account for company membership', () => {
    const guestId = createGuestAccount(db, { roomId: 'guest-room', now: 1 }).accountId;
    const accessId = accessAccount('membership-provenance');
    insertCompany('company-provenance');

    expect(() =>
      insertMember({
        companyId: 'company-provenance',
        accountId: guestId,
        role: 'member',
        state: 'active',
      }),
    ).toThrow(/provenance/);

    insertMember({
      companyId: 'company-provenance',
      accountId: accessId,
      role: 'member',
      state: 'active',
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM company_members`).get()).toEqual({
      count: 1,
    });

    db.prepare(
      `UPDATE accounts SET provenance = 'guest', guest_room_id = ?
       WHERE account_id = ?`,
    ).run('guest-room', accessId);
    expect(() =>
      db
        .prepare(
          `UPDATE company_members SET role = 'admin'
           WHERE company_id = ? AND account_id = ?`,
        )
        .run('company-provenance', accessId),
    ).toThrow(/provenance/);
  });

  it('guards invite hashes, redemption state, and expiry', () => {
    const creatorId = accessAccount('invite-creator');
    insertCompany('company-invites');
    const base = {
      companyId: 'company-invites',
      createdBy: creatorId,
      expiresAt: 100,
    };

    expect(() =>
      insertInvite({ ...base, inviteHash: 'a'.repeat(63) }),
    ).toThrow(/CHECK constraint/);
    expect(() =>
      insertInvite({ ...base, inviteHash: 'A'.repeat(64) }),
    ).toThrow(/CHECK constraint/);
    expect(() =>
      insertInvite({ ...base, inviteHash: 'g'.repeat(64) }),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      insertInvite({
        ...base,
        inviteHash: 'b'.repeat(64),
        redeemedBy: creatorId,
        redeemedAt: null,
      }),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      insertInvite({
        ...base,
        inviteHash: 'c'.repeat(64),
        redeemedBy: creatorId,
        redeemedAt: 50,
        revokedAt: 60,
      }),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      insertInvite({
        ...base,
        inviteHash: 'd'.repeat(64),
        expiresAt: 1,
        createdAt: 1,
      }),
    ).toThrow(/expires_at/);

    insertInvite({
      ...base,
      inviteHash: 'e'.repeat(64),
      redeemedBy: creatorId,
      redeemedAt: 50,
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM company_invites`).get()).toEqual({
      count: 1,
    });
  });

  it('deduplicates entitlement audit causes and ties processor event ids', () => {
    insertEntitlementAudit({
      auditId: 'audit-1',
      subjectId: 'subject-1',
      causeKind: 'membership',
      causeId: 'cause-1',
    });
    expect(() =>
      insertEntitlementAudit({
        auditId: 'audit-2',
        subjectId: 'subject-1',
        causeKind: 'membership',
        causeId: 'cause-1',
      }),
    ).toThrow(/UNIQUE constraint/);

    expect(() =>
      insertEntitlementAudit({
        auditId: 'audit-3',
        subjectId: 'subject-2',
        causeKind: 'processor_event',
        causeId: 'event-1',
        processorEventId: null,
      }),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      insertEntitlementAudit({
        auditId: 'audit-4',
        subjectId: 'subject-2',
        causeKind: 'membership',
        causeId: 'cause-2',
        processorEventId: 'event-2',
      }),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      insertEntitlementAudit({
        auditId: 'audit-5',
        subjectId: 'subject-2',
        causeKind: 'processor_event',
        causeId: 'event-3',
        processorEventId: 'event-other',
      }),
    ).toThrow(/CHECK constraint/);

    insertEntitlementAudit({
      auditId: 'audit-6',
      subjectId: 'subject-2',
      causeKind: 'processor_event',
      causeId: 'event-4',
      processorEventId: 'event-4',
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM entitlement_audit WHERE subject_id = ?`,
        )
        .get('subject-2'),
    ).toEqual({ count: 1 });
  });

  it('allows one referral redemption per account and later renewals', () => {
    const ownerId = accessAccount('referral-owner');
    const referredId = accessAccount('referral-referred');
    db.prepare(
      `INSERT INTO referral_codes (code, owner_account_id, created_at)
       VALUES ('ABC123', ?, 1)`,
    ).run(ownerId);

    function insertEvent(
      recordId: string,
      kind: 'redemption' | 'renewal' | 'reversal',
      objectId: string,
    ): void {
      db.prepare(
        `INSERT INTO referral_events (
           record_id, code, kind, referred_account_id, object_id,
           occurred_at, recorded_at
         ) VALUES (?, 'ABC123', ?, ?, ?, 1, 1)`,
      ).run(recordId, kind, referredId, objectId);
    }

    insertEvent('event-1', 'redemption', 'object-1');
    expect(() => insertEvent('event-2', 'redemption', 'object-2')).toThrow(
      /UNIQUE constraint/,
    );
    insertEvent('event-3', 'renewal', 'object-3');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM referral_events`).get()).toEqual({
      count: 2,
    });
  });

  it('applies the Phase 1 schema idempotently', () => {
    expect(() => {
      applyIdentitySchema(db);
      applyIdentitySchema(db);
    }).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM billing_events`).get()).toEqual({
      count: 0,
    });
  });
});

describe('tutor account cap', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function subject(subjectKey: string) {
    return { issuer: 'https://access.example.com', subject: subjectKey };
  }

  function countActiveAccessAccounts(): number {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM accounts
           WHERE provenance = 'access' AND state = 'active'`,
        )
        .get() as { count: number }
    ).count;
  }

  function countAccessSubjects(): number {
    return (
      db.prepare(`SELECT COUNT(*) AS count FROM access_subjects`).get() as {
        count: number;
      }
    ).count;
  }

  function seedTutorAccounts(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const outcome = resolveAccountForSubject(db, subject(`tutor-${index}`));
      if (isTutorCapReached(outcome)) {
        throw new Error(`seed tutor ${index} hit the cap unexpectedly`);
      }
    }
  }

  it('the 51st new Access subject is refused and creates no account', () => {
    expect(TUTOR_ACCOUNT_CAP_DEFAULT).toBe(50);
    seedTutorAccounts(TUTOR_ACCOUNT_CAP_DEFAULT);
    expect(countActiveAccessAccounts()).toBe(TUTOR_ACCOUNT_CAP_DEFAULT);

    const refused = resolveAccountForSubject(db, subject('tutor-overflow'));

    expect(refused).toEqual({ tutorCapReached: true });
    expect(countActiveAccessAccounts()).toBe(TUTOR_ACCOUNT_CAP_DEFAULT);
    expect(countAccessSubjects()).toBe(TUTOR_ACCOUNT_CAP_DEFAULT);
  });

  it('an existing account still resolves at the cap', () => {
    seedTutorAccounts(TUTOR_ACCOUNT_CAP_DEFAULT);

    const outcome = resolveAccountForSubject(db, subject('tutor-7'));

    if (isTutorCapReached(outcome)) {
      throw new Error('an existing tutor must never be capped');
    }
    expect(outcome.created).toBe(false);
    expect(outcome.account.accountId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('guest accounts do not count toward the cap', () => {
    createGuestAccount(db, { roomId: 'guest-room-cap-a', now: 1 });
    createGuestAccount(db, { roomId: 'guest-room-cap-b', now: 2 });

    const first = resolveAccountForSubject(db, subject('tutor-first'), {
      tutorAccountCap: 2,
    });
    const second = resolveAccountForSubject(db, subject('tutor-second'), {
      tutorAccountCap: 2,
    });

    expect(isTutorCapReached(first)).toBe(false);
    expect(isTutorCapReached(second)).toBe(false);
    expect(countActiveAccessAccounts()).toBe(2);
  });

  it('a disabled access account frees a slot', () => {
    const first = resolveAccountForSubject(db, subject('tutor-enabled'), {
      tutorAccountCap: 2,
    });
    resolveAccountForSubject(db, subject('tutor-other'), { tutorAccountCap: 2 });
    if (isTutorCapReached(first)) throw new Error('first tutor was capped');

    db.prepare(
      `UPDATE accounts SET state = 'disabled', updated_at = updated_at + 1
       WHERE account_id = ?`,
    ).run(first.account.accountId);

    const replacement = resolveAccountForSubject(db, subject('tutor-replacement'), {
      tutorAccountCap: 2,
    });

    if (isTutorCapReached(replacement)) {
      throw new Error('a disabled account must free a slot');
    }
    expect(replacement.created).toBe(true);
  });

  it('enforces a custom small cap exactly at the boundary', () => {
    const cap = { tutorAccountCap: 2 };
    const first = resolveAccountForSubject(db, subject('boundary-one'), cap);
    const second = resolveAccountForSubject(db, subject('boundary-two'), cap);
    if (isTutorCapReached(first) || isTutorCapReached(second)) {
      throw new Error('accounts below the cap must resolve');
    }

    const refused = resolveAccountForSubject(db, subject('boundary-three'), cap);

    expect(refused).toEqual({ tutorCapReached: true });
    expect(countActiveAccessAccounts()).toBe(2);
  });

  it('falls back to the default cap for a non-positive option', () => {
    const outcome = resolveAccountForSubject(db, subject('tutor-zero-cap'), {
      tutorAccountCap: 0,
    });

    expect(isTutorCapReached(outcome)).toBe(false);
  });
});
