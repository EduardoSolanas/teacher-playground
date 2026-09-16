/**
 * Width of the docked call rail, in one place.
 *
 * Used by the rail itself for its own width and by the room to decide where the
 * board stops. If the two ever disagree, the board either hides a strip of
 * itself behind the rail or leaves a gap of background beside it -- and both
 * look like a rendering bug rather than a mismatched constant.
 *
 * The floor is sized by the rail header: "Hide the call" beside the
 * Gallery/Focus/Hidden picker needs a little over 200px, and the 176px floor
 * clipped the picker's third option while wrapping it stranded the button.
 * 17rem fits the shared row with real slack at the narrowest docked width,
 * so font-metric variance cannot push the picker back into a wrap.
 */
export const CALL_RAIL_WIDTH = 'clamp(17rem,18vw,18rem)';
