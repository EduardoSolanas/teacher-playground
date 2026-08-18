export type RoomAccessStatus = 'none' | 'pending' | 'approved' | 'rejected';

export type GrantedPublicRole = 'creator' | 'peer' | 'viewer';

export interface CollaborationGateInput {
  /** GET /room returned 200. */
  roomGranted: boolean;
  /** GET /access payload status, when known. */
  accessStatus?: RoomAccessStatus | null;
  /** Role from an approved access response. */
  grantRole?: GrantedPublicRole | null;
  isWaiting: boolean;
  wasKicked: boolean;
}

function isGrantedPublicRole(role: GrantedPublicRole | null | undefined): boolean {
  return role === 'creator' || role === 'peer' || role === 'viewer';
}

/** True only when this account may open the y-webrtc provider for the room. */
export function shouldStartCollaboration(input: CollaborationGateInput): boolean {
  if (input.wasKicked || input.isWaiting) return false;
  if (input.roomGranted) return true;
  if (input.accessStatus === 'approved' && isGrantedPublicRole(input.grantRole)) {
    return true;
  }
  return false;
}
