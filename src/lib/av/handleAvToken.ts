/**
 * Issues a short-lived LiveKit join token for an admitted room participant.
 *
 * Waiting-room peers and non-members are refused with 403. Missing LiveKit
 * configuration is a 503 so the client can show a graceful "not configured" UX
 * without treating it as a permissions failure.
 */

import type { RoomDatabase } from '../whiteboard/db';
import { getGrantRole } from '../whiteboard/membership';
import { avEligible, avEligibilityStatus, type RoomRole } from './avAuthorization';
import {
  buildLiveKitToken,
  parseLiveKitConfig,
  type LiveKitConfig,
} from './livekitToken';
import { deriveLiveKitIdentity } from './participantIdentity';

export interface IssueAvTokenInput {
  readonly db: RoomDatabase;
  readonly env: unknown;
  readonly roomId: string;
  readonly accountId: string;
  readonly name?: string;
  /**
   * The caller's presence peerId, looked up by the server (RoomDO) from
   * presence state. Never a client-supplied value: a forged peerId here would
   * let a participant label their own A/V state onto another roster row.
   */
  readonly peerId?: string;
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
  const role = getGrantRole(input.db, input.roomId, input.accountId);
  const waiting = isWaitingAccount(input.db, input.roomId, input.accountId);

  // Banned overrides waiting_peers: a revoked account must not receive A/V
  // even if a stale waiting row remains.
  const eligibility =
    role === 'banned'
      ? avEligible('banned')
      : waiting
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

  // At this point, eligibility.eligible is true, which can only happen if the
  // role is an admitted role (owner, editor, viewer, or member). We've verified
  // the role via avEligible, so it's safe to narrow its type.
  return mintTokenResponse(config, input, role as RoomRole);
}

async function mintTokenResponse(
  config: LiveKitConfig,
  input: IssueAvTokenInput,
  role: RoomRole,
): Promise<Response> {
  // The LiveKit identity is always derived by the server from the verified
  // account. LiveKit enforces one live session per identity by disconnecting
  // the previous holder, so accepting a caller-chosen identity would let one
  // admitted participant bump another off the call; and because LiveKit shows
  // every participant every other participant's identity, the value must not
  // be the accountId itself (audit M4).
  const identity = await deriveLiveKitIdentity(config.apiSecret, input.roomId, input.accountId);
  const token = await buildLiveKitToken({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    room: input.roomId,
    identity,
    name: input.name,
    peerId: input.peerId,
    grant: {
      canPublish: role !== 'viewer',
      canPublishData: role !== 'viewer',
      canSubscribe: true,
      roomJoin: true,
      /*
       * Screen share belongs to the owner (Phase 10). Anyone else may share
       * only while the owner allows it on the live call, which the room grants
       * through LiveKit's UpdateParticipant and a rejoin takes away again.
       */
      ...(role === 'owner' ? {} : { canPublishSources: ['camera', 'microphone'] as const }),
    },
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
