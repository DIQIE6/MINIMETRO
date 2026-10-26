/**
 * A passenger is a plain object: it is created in large numbers and only ever
 * carries four fields, so a class would just add noise.
 *
 *  destShape       – the station shape this passenger wants to reach
 *  born            – game time when it appeared (used for the "waiting" tint)
 *  targetStationId – station it expects to alight at on the train it boarded
 *  lastLineId      – line it just left, so transfers do not bounce back
 */
export function makePassenger(destShape, born) {
  return { destShape, born, targetStationId: null, lastLineId: null };
}
