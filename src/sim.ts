// Pure simulation logic: the fleet, rollout plans, the error model and scoring.
// Nothing in here touches Cloudflare APIs, so it is unit-tested directly.

export type Region = "NA" | "EU" | "APAC" | "LATAM" | "AF";

export interface Datacenter {
  code: string;
  city: string;
  region: Region;
  /** Share of global requests served by this datacenter, in percent. Sums to 100. */
  traffic: number;
}

export const FLEET: Datacenter[] = [
  { code: "IAD", city: "Ashburn", region: "NA", traffic: 9 },
  { code: "EWR", city: "Newark", region: "NA", traffic: 6 },
  { code: "ORD", city: "Chicago", region: "NA", traffic: 6 },
  { code: "LAX", city: "Los Angeles", region: "NA", traffic: 6 },
  { code: "DFW", city: "Dallas", region: "NA", traffic: 5 },
  { code: "SJC", city: "San Jose", region: "NA", traffic: 5 },
  { code: "LHR", city: "London", region: "EU", traffic: 8 },
  { code: "FRA", city: "Frankfurt", region: "EU", traffic: 7 },
  { code: "AMS", city: "Amsterdam", region: "EU", traffic: 6 },
  { code: "CDG", city: "Paris", region: "EU", traffic: 5 },
  { code: "MAD", city: "Madrid", region: "EU", traffic: 4 },
  { code: "WAW", city: "Warsaw", region: "EU", traffic: 2 },
  { code: "NRT", city: "Tokyo", region: "APAC", traffic: 6 },
  { code: "SIN", city: "Singapore", region: "APAC", traffic: 5 },
  { code: "HKG", city: "Hong Kong", region: "APAC", traffic: 4 },
  { code: "BOM", city: "Mumbai", region: "APAC", traffic: 4 },
  { code: "SYD", city: "Sydney", region: "APAC", traffic: 4 },
  { code: "GRU", city: "São Paulo", region: "LATAM", traffic: 5 },
  { code: "SCL", city: "Santiago", region: "LATAM", traffic: 1 },
  { code: "JNB", city: "Johannesburg", region: "AF", traffic: 2 },
];

const BY_CODE = new Map(FLEET.map((dc) => [dc.code, dc]));

export function datacenter(code: string): Datacenter {
  const dc = BY_CODE.get(code);
  if (!dc) throw new Error(`unknown datacenter ${code}`);
  return dc;
}

// ---------------------------------------------------------------------------
// Rollout plans
// ---------------------------------------------------------------------------

export type Strategy = "big-bang" | "fast" | "staged";

export interface RolloutPlan {
  strategy: Strategy;
  /** Datacenter that receives the change first. */
  canary: string;
  /** How long each stage bakes before its health check, in seconds. */
  bakeSec: number;
}

export const BAKE_OPTIONS = [5, 15, 30];
export const DEFAULT_PLAN: RolloutPlan = { strategy: "staged", canary: "SCL", bakeSec: 15 };

/** Cumulative traffic targets (in %) for each strategy. 0 means "the canary alone". */
const TARGETS: Record<Strategy, number[]> = {
  "big-bang": [100],
  fast: [10, 100],
  staged: [0, 10, 50, 100],
};

/**
 * The order datacenters receive a change: the canary first, then the smallest
 * datacenters, with APAC last (it is the middle of the night there when the
 * change window opens, so it goes last by default).
 */
export function rolloutOrder(canary: string): string[] {
  const rest = FLEET.filter((dc) => dc.code !== canary).sort((a, b) => {
    const apac = Number(a.region === "APAC") - Number(b.region === "APAC");
    return apac || a.traffic - b.traffic || a.code.localeCompare(b.code);
  });
  return [datacenter(canary).code, ...rest.map((dc) => dc.code)];
}

/** Splits the fleet into stages according to the plan. */
export function buildStages(plan: RolloutPlan): string[][] {
  const order = rolloutOrder(plan.canary);
  const stages: string[][] = [];
  let next = 0;
  let cumulative = 0;
  for (const target of TARGETS[plan.strategy]) {
    const stage: string[] = [];
    do {
      const code = order[next++];
      stage.push(code);
      cumulative += datacenter(code).traffic;
    } while (next < order.length && cumulative < target);
    stages.push(stage);
  }
  return stages;
}

export function trafficShare(codes: string[]): number {
  return codes.reduce((sum, code) => sum + datacenter(code).traffic, 0);
}

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/** How a bad config hurts the datacenters running it. Hidden from the player and the co-pilot. */
export type FailureMode =
  | { kind: "none" }
  /** The proxy rejects the config and serves 5xx straight away. Detectable by validation. */
  | { kind: "crash"; rate: number }
  /** Errors start after `onsetSec` and ramp to `peak` over `rampSec` (e.g. CPU exhaustion). */
  | { kind: "slow-burn"; onsetSec: number; rampSec: number; peak: number }
  /** Only datacenters in one region fail. */
  | { kind: "regional"; region: Region; rate: number }
  /** A small error rate that stays under the automatic health gate. */
  | { kind: "subtle"; rate: number };

/** Error rate (0..1) caused by the new config in `dc`, `secondsSinceApply` after it landed. */
export function configErrorRate(mode: FailureMode, dc: Datacenter, secondsSinceApply: number): number {
  switch (mode.kind) {
    case "none":
      return 0;
    case "crash":
      return mode.rate;
    case "slow-burn": {
      const t = secondsSinceApply - mode.onsetSec;
      if (t <= 0) return 0;
      return Math.min(mode.peak, (mode.peak * t) / mode.rampSec);
    }
    case "regional":
      return dc.region === mode.region ? mode.rate : 0;
    case "subtle":
      return mode.rate;
  }
}

/** Whether "fail stale" validation would catch this config and keep the last known-good one. */
export function failsValidation(mode: FailureMode): boolean {
  return mode.kind === "crash";
}

/** Per-datacenter error rate above which the health gate rolls back automatically. */
export const HEALTH_GATE = 0.1;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type Grade = "S" | "A" | "B" | "C" | "D" | "F";

export interface Outcome {
  /** The config was bad and ended up rolled back, or it was good and reached 100%. */
  passed: boolean;
  grade: Grade;
  /** Blast radius: % of global requests failing, integrated over seconds. */
  blast: number;
  note: string;
}

const GRADE_THRESHOLDS: [Grade, number][] = [
  ["S", 6],
  ["A", 20],
  ["B", 60],
  ["C", 150],
];

export function scoreRollout(input: {
  bad: boolean;
  shipped: boolean;
  blast: number;
  strategy: Strategy;
  /** Fail-stale validation kept the bad config from serving: engineering, not luck. */
  validated?: boolean;
}): Outcome {
  const { bad, shipped, blast, strategy, validated = false } = input;
  if (bad && shipped) {
    return { passed: false, grade: "F", blast, note: "A bad change reached the whole fleet." };
  }
  if (!bad && !shipped) {
    return { passed: false, grade: "F", blast, note: "A good change was rolled back. Shipping safely still means shipping." };
  }
  let grade: Grade = GRADE_THRESHOLDS.find(([, max]) => blast <= max)?.[0] ?? "D";
  let note = bad ? "Contained." : "Shipped.";
  if (strategy === "big-bang" && !validated && (grade === "S" || grade === "A")) {
    // Pushing everywhere at once and getting away with it is luck, not engineering.
    grade = "B";
    note += " Big-bang deploys cap at B: you got lucky.";
  }
  return { passed: true, grade, blast, note };
}
