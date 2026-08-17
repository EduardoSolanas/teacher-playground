import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  IdentityInputError,
  applyIdentitySchema,
  resolveAccountForSubject,
  readAccountAuthorizations,
} from './identityStore';
import { applySchema as applyRoomSchema } from '../whiteboard/roomSchema';

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

    expect(tables).toEqual(['access_subjects', 'accounts', 'authorization_audit', 'sessions']);

    const columns = tables.flatMap((table) =>
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
    const first = resolveAccountForSubject(db, {
      issuer: 'https://access.example.com',
      subject: 'google-subject-1',
    });
    const second = resolveAccountForSubject(db, {
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
    const first = resolveAccountForSubject(db, {
      issuer: 'https://access.example.com',
      subject: 'google-subject',
    });
    const second = resolveAccountForSubject(db, {
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
    const resolved = resolveAccountForSubject(db, {
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
    const resolved = resolveAccountForSubject(db, {
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

    const resolved = resolveAccountForSubject(db, {
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
    return resolveAccountForSubject(db, { issuer, subject }).account;
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
