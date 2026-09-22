/** Moved to src/validation/replayInvariants.ts (unchanged) so it can be shared by both the
 *  test suite and the validation harness CLI (src/sim/*, which lives under src/ and cannot
 *  import from tests/). Re-exported here so this file's existing import path keeps working. */
export { collectReplayInvariantViolations, type ReplayQaInput } from "../../src/validation/replayInvariants.js";
