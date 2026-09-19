import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  SELF,
} from 'cloudflare:test';
import worker from './worker';
import { getIdentityObject, type IdentityDO } from './do/IdentityDO';
import type { RoomDO } from './do/RoomDO';
import { authenticatedFetch, bootstrapLocalSession, type LocalAuthSession } from './test/workerAuth';
import {
  ROOM_BACKUP_TABLES,
  backupObjectKey,
  restoreBackup,
  type BackupDump,
} from './lib/backup/backup';
import {
  runBackupCycle,
  type BackupCycleEnv,
} from './lib/backup/backupCycle';

/*
 * BAK-01: the scheduled backup cycle against real Durable Objects, real
 * SQLite and the real (miniflare) R2 bucket. The restore rehearsal replays an
 * exported dump into a second, freshly-constructed RoomDO and requires row
 * parity for every backed-up table.
 */

function identityStub(): DurableObjectStub<IdentityDO> {
  return getIdentityObject(
    (env as unknown as { IDENTITY: DurableObjectNamespace<IdentityDO> }).IDENTITY,
  );
}

function roomStub(roomId: string): DurableObjectStub<RoomDO> {
  const rooms = (env as unknown as { ROOMS: DurableObjectNamespace }).ROOMS;
  return rooms.get(rooms.idFromName(roomId)) as DurableObjectStub<RoomDO>;
}

function boardFiles(): R2Bucket {
  return (env as unknown as { BOARD_FILES: R2Bucket }).BOARD_FILES;
}

function cycleEnv(): BackupCycleEnv {
  return env as unknown as BackupCycleEnv;
}

function postIdentity(path: string, body: unknown): Promise<Response> {
  return identityStub().fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function registerRoom(roomId: string): Promise<Response> {
  return postIdentity('https://identity/backup/register', {
    doClass: 'rooms',
    doId: roomId,
    lastActivityAt: Date.now(),
  });
}

async function dueList(): Promise<Array<{ doClass: string; doId: string }>> {
  const response = await postIdentity('https://identity/backup/due', { now: Date.now() });
  const body = await response.json() as { due: Array<{ doClass: string; doId: string }> };
  return body.due;
}

function seedRoomData(roomId: string): Promise<void> {
  return runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
    const now = Date.now() - 5_000;
    instance.db.prepare(
      `INSERT INTO rooms (room_id, elements, viewport, name, created_at, updated_at)
       VALUES (?, '[]', '{"x":0,"y":0,"zoom":1}', 'Backup room', ?, ?)`,
    ).run(roomId, now, now + 1);
    instance.db.prepare(
      `INSERT INTO room_members (
         room_id, account_id, role, display_name, email,
         requested_at, created_at, updated_at, expires_at
       ) VALUES (?, ?, 'owner', 'Teacher', 'teacher@example.test', NULL, ?, ?, NULL)`,
    ).run(roomId, 'acc-owner', now, now);
    instance.db.prepare(
      `INSERT INTO room_members (
         room_id, account_id, role, display_name, email,
         requested_at, created_at, updated_at, expires_at
       ) VALUES (?, ?, 'editor', NULL, NULL, ?, ?, ?, ?)`,
    ).run(roomId, 'acc-editor', now, now, now, now + 2);
    instance.db.prepare(
      `INSERT INTO room_presence (
         room_id, peer_id, user_name, color, first_seen, last_seen
       ) VALUES (?, ?, 'Teacher', '#00ff00', ?, ?)`,
    ).run(roomId, 'peer-1', now, now + 3);
    instance.db.prepare(
      `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at)
       VALUES (?, ?, 'Guest', '#0000ff', ?)`,
    ).run(roomId, 'peer-2', now);
  });
}

function tableRows(instance: RoomDO): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const table of ROOM_BACKUP_TABLES) {
    out[table] = (
      instance.db.prepare(`SELECT * FROM "${table}"`).all() as unknown[]
    ).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  }
  return out;
}

function backupKeys(prefix: string): Promise<string[]> {
  return boardFiles().list({ prefix }).then((listed) =>
    listed.objects.map((object) => object.key),
  );
}

describe('scheduled backup cycle (BAK-01)', () => {
  it('exports a due room to R2, marks it done, and restores with row parity', async () => {
    const roomId = `backup-cycle-${crypto.randomUUID().slice(0, 8)}`;
    await seedRoomData(roomId);
    const registered = await registerRoom(roomId);
    expect(registered.status).toBe(200);
    expect(await dueList()).toContainEqual({ doClass: 'rooms', doId: roomId });

    const result = await runBackupCycle(cycleEnv(), Date.now());
    expect(result.enabled).toBe(true);
    expect(result.exported).toBe(1);
    expect(result.failed).toBe(0);

    const keys = await backupKeys(`backups/rooms/${roomId}/`);
    expect(keys).toHaveLength(1);
    const object = await boardFiles().get(keys[0]);
    expect(object).not.toBeNull();
    const dump = await object!.json() as BackupDump;
    expect(dump.version).toBe(1);
    expect(dump.tables.map((table) => table.name)).toEqual([...ROOM_BACKUP_TABLES]);
    expect(dump.tables.find((table) => table.name === 'room_members')!.rows).toHaveLength(2);
    expect(dump.tables.find((table) => table.name === 'room_presence')!.rows).toHaveLength(1);
    expect(dump.tables.find((table) => table.name === 'waiting_peers')!.rows).toHaveLength(1);
    expect(keys[0]).toBe(backupObjectKey('rooms', roomId, dump.createdAt));

    expect(await dueList()).not.toContainEqual({ doClass: 'rooms', doId: roomId });

    // The restore rehearsal: a second, freshly-constructed RoomDO replays the
    // dump from R2 and must match the source row for row, table for table.
    const restoredId = `backup-restore-${crypto.randomUUID().slice(0, 8)}`;
    await runInDurableObject(roomStub(restoredId), (instance: RoomDO) => {
      restoreBackup(instance.db, dump);
    });
    const sourceRows = await runInDurableObject(roomStub(roomId), tableRows);
    const restoredRows = await runInDurableObject(roomStub(restoredId), tableRows);
    expect(restoredRows).toEqual(sourceRows);
  });

  it('does not re-export a room backed up inside the cadence', async () => {
    const result = await runBackupCycle(cycleEnv(), Date.now());
    expect(result.exported).toBe(0);
    expect(await backupKeys('backups/rooms/')).toHaveLength(1);
  });

  it('stops the whole cycle when BACKUPS_ENABLED is off', async () => {
    const mutable = env as unknown as { BACKUPS_ENABLED?: string };
    const original = mutable.BACKUPS_ENABLED;
    mutable.BACKUPS_ENABLED = 'off';
    try {
      const before = (await backupKeys('backups/')).length;
      const result = await runBackupCycle(cycleEnv(), Date.now());
      expect(result.enabled).toBe(false);
      expect(result.exported).toBe(0);
      expect((await backupKeys('backups/')).length).toBe(before);
    } finally {
      mutable.BACKUPS_ENABLED = original;
    }
  });

  it('serves the export route inside the DO and refuses it from the public API', async () => {
    const roomId = `backup-route-${crypto.randomUUID().slice(0, 8)}`;
    await seedRoomData(roomId);
    const session: LocalAuthSession = await bootstrapLocalSession(
      `backup-route-${crypto.randomUUID().slice(0, 8)}`,
    );

    const response = await roomStub(roomId).fetch(
      new Request(
        `https://room/room/backup/export?roomId=${encodeURIComponent(roomId)}`,
        { method: 'POST' },
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { dump: BackupDump };
    expect(body.dump.version).toBe(1);
    expect(body.dump.tables.map((table) => table.name)).toEqual([...ROOM_BACKUP_TABLES]);

    const wrongMethod = await roomStub(roomId).fetch(
      new Request(
        `https://room/room/backup/export?roomId=${encodeURIComponent(roomId)}`,
        { method: 'GET' },
      ),
    );
    expect(wrongMethod.status).toBe(405);

    // An authenticated account must not pull the room's full SQLite dump
    // through the public API either; only the cron cycle, over the namespace
    // binding, may.
    const publicResponse = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/backup/export`,
      session,
      { method: 'POST' },
    );
    expect(publicResponse.status).toBe(404);
  });

  it('continues past a failing target and still exports the healthy one', async () => {
    const roomId = `backup-resume-${crypto.randomUUID().slice(0, 8)}`;
    await seedRoomData(roomId);
    await registerRoom(roomId);
    // A registry row naming an invalid room id: the export request reaches a
    // RoomDO whose route refuses it, which is the failure the cycle must skip.
    await runInDurableObject(identityStub(), (instance: IdentityDO) => {
      instance.db.prepare(
        `INSERT OR REPLACE INTO backup_registry (do_class, do_id, last_backup_at, last_activity_at)
         VALUES ('rooms', '../etc/passwd', NULL, ?)`,
      ).run(Date.now());
    });

    const result = await runBackupCycle(cycleEnv(), Date.now());
    expect(result.failed).toBe(1);
    expect(result.exported).toBe(1);
    expect(await backupKeys(`backups/rooms/${roomId}/`)).toHaveLength(1);
    expect(await dueList()).not.toContainEqual({ doClass: 'rooms', doId: roomId });
  });

  it('registers a room in the backup registry when owner activity is touched', async () => {
    const roomId = `backup-touch-${crypto.randomUUID().slice(0, 8)}`;
    await seedRoomData(roomId);
    expect(await dueList()).not.toContainEqual({ doClass: 'rooms', doId: roomId });

    await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
      const touch = instance as unknown as {
        touchOwnerRoomActivity(roomId: string, opts?: { force?: boolean }): Promise<void>;
      };
      await touch.touchOwnerRoomActivity(roomId);
    });
    expect(await dueList()).toContainEqual({ doClass: 'rooms', doId: roomId });

    // A forced touch refreshes the activity stamp on the same row.
    await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
      const touch = instance as unknown as {
        touchOwnerRoomActivity(roomId: string, opts?: { force?: boolean }): Promise<void>;
      };
      await touch.touchOwnerRoomActivity(roomId, { force: true });
    });
    expect(await dueList()).toContainEqual({ doClass: 'rooms', doId: roomId });
  });

  it('runs the cycle from the Worker scheduled handler', async () => {
    const roomId = `backup-cron-${crypto.randomUUID().slice(0, 8)}`;
    await seedRoomData(roomId);
    await registerRoom(roomId);

    await worker.scheduled(
      createScheduledController(),
      env,
      createExecutionContext(),
    );

    expect(await backupKeys(`backups/rooms/${roomId}/`)).toHaveLength(1);
    expect(await dueList()).not.toContainEqual({ doClass: 'rooms', doId: roomId });
  });
});
