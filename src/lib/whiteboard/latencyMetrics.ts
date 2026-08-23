export interface LatencySummary {
  count: number;
  min: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
}

function nearestRank(sortedSamples: number[], percentile: number): number {
  const rank = Math.max(1, Math.ceil(percentile * sortedSamples.length));
  return sortedSamples[rank - 1];
}

export function summarizeLatencySamples(samples: readonly number[]): LatencySummary {
  const validSamples = samples.filter((sample) => Number.isFinite(sample) && sample >= 0).sort((a, b) => a - b);

  if (validSamples.length === 0) {
    return { count: 0, min: null, max: null, p50: null, p95: null };
  }

  return {
    count: validSamples.length,
    min: validSamples[0],
    max: validSamples[validSamples.length - 1],
    p50: nearestRank(validSamples, 0.5),
    p95: nearestRank(validSamples, 0.95),
  };
}
