/**
 * Width of the docked call rail, in one place.
 *
 * Used by the rail itself for its own width and by the room to decide where the
 * board stops. If the two ever disagree, the board either hides a strip of
 * itself behind the rail or leaves a gap of background beside it -- and both
 * look like a rendering bug rather than a mismatched constant.
 */
export const CALL_RAIL_WIDTH = 'clamp(11rem,18vw,15rem)';
