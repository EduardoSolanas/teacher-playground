/**
 * Issues a short-lived LiveKit join token for an admitted room participant.
 *
 * Waiting-room peers and non-members are refused with 403. Missing LiveKit
 * configuration is a 503 so the client can show a graceful "not configured" UX
 * without treating it as a permissions failure.
 */

import type { RoomDatabase } from '../whiteboard/db';
import { getRoomRole } from '../whiteboard/roomSchema';
import { avEligible, avEligibilityStatus } from './avAuthorization';
import {
  buildLiveKitToken,
  parseLiveKitConfig,
  type LiveKitConfig,
} from './livekitToken';

export interface IssueAvTokenInput {
  readonly db: RoomDatabase;
  readonly env: unknown;
  readonly roomId: string;
  readonly accountId: string;
  readonly name?: string;
}

function isWaitingAccount(
  db: RoomDatabase,
  roomId: string,
  accountId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM waiting_peers WHERE room_id = ? AND account_id = ? LIMIT 1`,
    )
    .get(roomId, accountId) as { ok: number } | undefined;
  return row !== undefined;
}

export async function issueAvTokenResponse(
  input: IssueAvTokenInput,
): Promise<Response> {
  const config = parseLiveKitConfig(input.env);
  const role = getRoomRole(input.db, input.roomId, input.accountId);
  const waiting = isWaitingAccount(input.db, input.roomId, input.accountId);

  // Waiting overrides membership: a suspended member back in the queue must
  // not receive A/V until they are admitted again.
  const eligibility = waiting
    ? { eligible: false as const, reason: 'waiting' as const }
    : avEligible(role);

  const status = avEligibilityStatus(eligibility.eligible, config !== null);
  if (status !== 200 || !config) {
    const error =
      status === 503
        ? 'LiveKit is not configured'
        : eligibility.reason === 'waiting'
          ? 'A/V available after admission'
          : 'Forbidden';
    return Response.json(
      { error, reason: status === 503 ? 'unconfigured' : eligibility.reason },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return mintTokenResponse(config, input);
}

async function mintTokenResponse(
  config: LiveKitConfig,
  input: IssueAvTokenInput,
): Promise<Response> {
  // The LiveKit identity is always the server-verified account. LiveKit
  // enforces one live session per identity by disconnecting the previous
  // holder, so accepting a caller-chosen identity would let one admitted
  // participant bump another off the call.
  const identity = input.accountId;
  const token = await buildLiveKitToken({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    room: input.roomId,
    identity,
    name: input.name,
  });

  return Response.json(
    {
      token,
      url: config.url,
      room: input.roomId,
      identity,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
