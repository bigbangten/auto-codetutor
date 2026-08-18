/**
 * Pick the closest block that carries a verified source/document anchor.
 * Prefer anchors from the same heading section and, on an equal distance,
 * the preceding explanation so examples naturally inherit their context.
 */
export function nearestGroundedBlock(
  targetIndex: number,
  groundedIndices: number[],
  sectionByIndex: number[],
): number | undefined {
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= sectionByIndex.length) return undefined;
  const valid = groundedIndices.filter((index) => Number.isInteger(index) && index >= 0 && index < sectionByIndex.length);
  if (!valid.length) return undefined;
  if (valid.includes(targetIndex)) return targetIndex;

  const section = sectionByIndex[targetIndex];
  const local = valid.filter((index) => sectionByIndex[index] === section);
  const candidates = local.length ? local : valid;
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - targetIndex);
    const candidatePrecedes = candidate < targetIndex;
    const bestPrecedes = best !== undefined && best < targetIndex;
    if (distance < bestDistance || (distance === bestDistance && candidatePrecedes && !bestPrecedes)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
