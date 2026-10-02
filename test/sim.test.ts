import { describe, expect, it } from "vitest";
import { LEVELS, configDiff } from "../src/levels";
import { FLEET, buildStages, configErrorRate, datacenter, rolloutOrder, scoreRollout, trafficShare } from "../src/sim";

describe("fleet", () => {
  it("traffic shares sum to 100%", () => {
    expect(trafficShare(FLEET.map((dc) => dc.code))).toBe(100);
  });
});

describe("buildStages", () => {
  it("covers every datacenter exactly once, for every strategy", () => {
    for (const strategy of ["big-bang", "fast", "staged"] as const) {
      const stages = buildStages({ strategy, canary: "SCL", bakeSec: 15 });
      const codes = stages.flat();
      expect(new Set(codes).size).toBe(FLEET.length);
      expect(codes.length).toBe(FLEET.length);
    }
  });

  it("staged rollouts start with the canary alone", () => {
    const stages = buildStages({ strategy: "staged", canary: "SYD", bakeSec: 15 });
    expect(stages).toHaveLength(4);
    expect(stages[0]).toEqual(["SYD"]);
    expect(trafficShare(stages.slice(0, 2).flat())).toBeGreaterThanOrEqual(10);
    expect(trafficShare(stages.slice(0, 3).flat())).toBeGreaterThanOrEqual(50);
  });

  it("big-bang is a single stage", () => {
    expect(buildStages({ strategy: "big-bang", canary: "SCL", bakeSec: 5 })).toHaveLength(1);
  });

  it("rolls APAC out last unless the canary is in APAC", () => {
    const order = rolloutOrder("SCL");
    const firstApac = order.findIndex((code) => datacenter(code).region === "APAC");
    expect(order.slice(firstApac).every((code) => datacenter(code).region === "APAC")).toBe(true);
    // With a non-APAC canary, the first three stages of a staged rollout never touch APAC.
    const stages = buildStages({ strategy: "staged", canary: "SCL", bakeSec: 15 });
    expect(stages.slice(0, 3).flat().some((code) => datacenter(code).region === "APAC")).toBe(false);
  });
});

describe("configErrorRate", () => {
  const sin = datacenter("SIN");
  const lhr = datacenter("LHR");

  it("slow-burn is clean before onset and ramps to its peak", () => {
    const mode = { kind: "slow-burn", onsetSec: 10, rampSec: 15, peak: 0.6 } as const;
    expect(configErrorRate(mode, lhr, 5)).toBe(0);
    expect(configErrorRate(mode, lhr, 17.5)).toBeCloseTo(0.3);
    expect(configErrorRate(mode, lhr, 120)).toBe(0.6);
  });

  it("regional failures only hit their region", () => {
    const mode = { kind: "regional", region: "APAC", rate: 0.8 } as const;
    expect(configErrorRate(mode, sin, 1)).toBe(0.8);
    expect(configErrorRate(mode, lhr, 1)).toBe(0);
  });
});

describe("scoreRollout", () => {
  it("fails when a bad change ships or a good change is rolled back", () => {
    expect(scoreRollout({ bad: true, shipped: true, blast: 0, strategy: "staged" }).grade).toBe("F");
    expect(scoreRollout({ bad: false, shipped: false, blast: 0, strategy: "staged" }).grade).toBe("F");
  });

  it("grades by blast radius", () => {
    expect(scoreRollout({ bad: true, shipped: false, blast: 1, strategy: "staged" }).grade).toBe("S");
    expect(scoreRollout({ bad: true, shipped: false, blast: 30, strategy: "staged" }).grade).toBe("B");
    expect(scoreRollout({ bad: true, shipped: false, blast: 500, strategy: "staged" }).grade).toBe("D");
  });

  it("caps lucky big-bang deploys at B", () => {
    expect(scoreRollout({ bad: false, shipped: true, blast: 0, strategy: "big-bang" }).grade).toBe("B");
    expect(scoreRollout({ bad: true, shipped: false, blast: 0, strategy: "big-bang", validated: true }).grade).toBe("S");
  });
});

describe("levels", () => {
  it("every level has a readable diff with at least one change", () => {
    for (const level of LEVELS) {
      expect(configDiff(level)).toMatch(/^\+ /m);
    }
  });
});
