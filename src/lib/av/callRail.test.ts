import { describe, expect, it } from 'vitest';
import { CALL_RAIL_WIDTH } from './callRail';

describe('CALL_RAIL_WIDTH', () => {
  /*
   * The rail floor is sized by the rail header: "Hide the call" beside the
   * Gallery/Focus/Hidden picker needs a little over 200px, so the floor is
   * 17rem -- wide enough for the shared row with slack for font-metric
   * variance. Pinning the value here because the same constant drives the
   * room canvas inset; a silent change would re-clip the picker or leave a
   * gap beside the board, and Stryker's string mutants must fail this.
   */
  it('keeps the docked rail wide enough for the shared header row', () => {
    expect(CALL_RAIL_WIDTH).toBe('clamp(17rem,18vw,18rem)');
  });
});
