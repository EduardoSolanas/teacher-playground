import {
  BACKUP_VERSION,
  backupObjectKey,
  parseBackupsEnabled,
  type BackupDump,
  type BackupTableDump,
} from './backup';

/**
 * The daily backup cycle (BAK-01), kept in a lib so it is directly testable
 * from the workers suite: the Worker's scheduled handler delegates here, and
 * the tests drive it with the real env (real Durable Object namespaces and the
 * real BOARD_FILES bucket).
 */

export interface BackupCycleEnv {
  ROOMS: DurableObjectNamespace;
  IDENTITY: DurableObjectNamespace;
  /** Private export bucket. The cycle refuses to run without it. */
  BOARD_FILES: R2Bucket;
  /** Kill switch parsed by parseBackupsEnabled; unset means enabled. */
  BACKUPS_ENABLED?: string;
}

/**
 * Injectable log sinks. The cycle's I/O stays real (the workers tests exercise
 * it against real objects); only the log lines are replaceable so a test can
 * quiet or assert them without a test double anywhere in the data path.
 */
export interface BackupCycleLoggers {
  error?: (entry: Record<string, unknown>) => void;
}

export interface BackupCycleResult {
  enabled: boolean;
  /** Entries the identity registry reported due for this cycle. */
  due: number;
  /** Exports written to R2 and marked done. */
  exported: number;
  /** Targets whose export or mark-done failed; the cycle moved on. */
  failed: number;
  /** Registry entries naming a class this cycle does not export yet. */
  skippedUnsupportedClass: number;
  /** True when BOARD_FILES was not bound; nothing ran. */
  missingBucket: boolean;
}

const BACKUP_DUE_URL = 'https://identity/backup/due';
const BACKUP_MARK_DONE_URL = 'https://identity/backup/mark-done';
const ROOM_EXPORT_URL = 'https://room/room/backup/export';

function defaultErrorLogger(entry: Record<string, unknown>): void {
  console.error(JSON.stringify({ event: 'backup_cycle_error', ...entry }));
}

function parseDump(value: unknown): BackupDump | null {
  if (typeof value !== 'object' || value === null) return null;
  const dump = value as { version?: unknown; createdAt?: unknown; tables?: unknown };
  if (dump.version !== BACKUP_VERSION) return null;
  if (typeof dump.createdAt !== 'number' || !Number.isFinite(dump.createdAt)) return null;
  if (!Array.isArray(dump.tables)) return null;
  for (const table of dump.tables) {
    if (typeof table !== 'object' || table === null) return null;
    const entry = table as { name?: unknown; rows?: unknown };
    if (typeof entry.name !== 'string' || !Array.isArray(entry.rows)) return null;
  }
  return dump as {
    version: typeof BACKUP_VERSION;
    createdAt: number;
    tables: BackupTableDump[];
  };
}

/**
 * Runs one backup cycle: read the due list from IdentityDO, export each due
 * RoomDO to R2, then record completion. Per-target failures are logged and
 * skipped so one broken room can never take down the whole run, and the cycle
 * itself never throws — a scheduled handler that threw would only turn a
 * backup gap into a cron alert nobody wired up.
 */
export async function runBackupCycle(
  env: BackupCycleEnv,
  now: number,
  helpers: BackupCycleLoggers = {},
): Promise<BackupCycleResult> {
  const logError = helpers.error ?? defaultErrorLogger;
  const result: BackupCycleResult = {
    enabled: true,
    due: 0,
    exported: 0,
    failed: 0,
    skippedUnsupportedClass: 0,
    missingBucket: false,
  };

  if (!parseBackupsEnabled(env.BACKUPS_ENABLED)) {
    result.enabled = false;
    return result;
  }
  if (!env.BOARD_FILES) {
    result.missingBucket = true;
    logError({ reason: 'missing_board_files_binding' });
    return result;
  }

  const identity = env.IDENTITY.get(env.IDENTITY.idFromName('global'));
  let targets: Array<{ doClass: string; doId: string }> = [];
  try {
    const response = await identity.fetch(new Request(BACKUP_DUE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ now }),
    }));
    if (!response.ok) {
      logError({ reason: 'due_list_failed', status: response.status });
      return result;
    }
    const body = await response.json() as { due?: unknown };
    if (!Array.isArray(body.due)) {
      logError({ reason: 'due_list_invalid' });
      return result;
    }
    targets = body.due.filter(
      (entry): entry is { doClass: string; doId: string } =>
        typeof entry === 'object' && entry !== null &&
        typeof (entry as { doClass?: unknown }).doClass === 'string' &&
        typeof (entry as { doId?: unknown }).doId === 'string',
    );
  } catch (error) {
    logError({
      reason: 'due_list_unreachable',
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  result.due = targets.length;
  for (const target of targets) {
    if (target.doClass !== 'rooms') {
      // The registry schema admits the identity class, but its export route is
      // a later slice; skipping keeps the entry due instead of marking it done
      // against a bucket write that never happened.
      result.skippedUnsupportedClass += 1;
      logError({ reason: 'unsupported_do_class', doClass: target.doClass, doId: target.doId });
      continue;
    }
    try {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(target.doId));
      const response = await stub.fetch(new Request(
        `${ROOM_EXPORT_URL}?roomId=${encodeURIComponent(target.doId)}`,
        { method: 'POST' },
      ));
      if (!response.ok) {
        throw new Error(`export failed with status ${response.status}`);
      }
      const body = await response.json() as { dump?: unknown };
      const dump = parseDump(body?.dump);
      if (dump === null) {
        throw new Error('export returned a malformed dump');
      }
      const key = backupObjectKey('rooms', target.doId, dump.createdAt);
      await env.BOARD_FILES.put(key, JSON.stringify(dump), {
        httpMetadata: { contentType: 'application/json' },
      });
      const done = await identity.fetch(new Request(BACKUP_MARK_DONE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          doClass: target.doClass,
          doId: target.doId,
          at: dump.createdAt,
        }),
      }));
      if (!done.ok) {
        throw new Error(`mark-done failed with status ${done.status}`);
      }
      result.exported += 1;
    } catch (error) {
      result.failed += 1;
      logError({
        reason: 'export_failed',
        doClass: target.doClass,
        doId: target.doId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
