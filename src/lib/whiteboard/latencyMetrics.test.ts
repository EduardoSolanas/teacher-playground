import { describe, expect, it } from "vitest";

import { summarizeLatencySamples } from "./latencyMetrics";

describe("summarizeLatencySamples", () => {
  it("summarizes valid samples with nearest-rank percentiles", () => {
    expect(summarizeLatencySamples([4, 1, 9, 2, 7, 3, 8, 6, 5, 10])).toEqual({
      count: 10,
      min: 1,
      max: 10,
      p50: 5,
      p95: 10,
    });
  });

  it("ignores negative and non-finite samples", () => {
    expect(
      summarizeLatencySamples([10, -1, Number.NaN, Number.POSITIVE_INFINITY, 20]),
    ).toEqual({
      count: 2,
      min: 10,
      max: 20,
      p50: 10,
      p95: 20,
    });
  });

  it("represents an empty or entirely invalid sample set safely", () => {
    expect(summarizeLatencySamples([])).toEqual({
      count: 0,
      min: null,
      max: null,
      p50: null,
      p95: null,
    });
    expect(summarizeLatencySamples([-1, Number.NaN, Number.NEGATIVE_INFINITY])).toEqual({
      count: 0,
      min: null,
      max: null,
      p50: null,
      p95: null,
    });
  });
});
