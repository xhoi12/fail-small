import type { FailureMode } from "./sim";

export type ConfigValue = string | number | boolean | string[];
export type Config = Record<string, ConfigValue>;

export interface Level {
  id: string;
  title: string;
  ticket: {
    id: string;
    author: string;
    summary: string;
    description: string;
  };
  config: { name: string; consumer: string; before: Config; after: Config };
  /** Hidden from the player and from the co-pilot. */
  failure: FailureMode;
  /** Scripted pre-flight review used when Workers AI is unavailable. */
  offlineReview: string;
  /** Shown in the debrief. */
  lesson: string;
  /** Public postmortem the level is loosely based on, if any. */
  inspiredBy?: { title: string; url: string };
}

export const LEVELS: Level[] = [
  {
    id: "routine",
    title: "Routine Change",
    ticket: {
      id: "CHG-1042",
      author: "maya (API Shield)",
      summary: "Raise the login rate limit from 60 to 100 requests/minute",
      description:
        "Customers behind large NATs keep hitting the login limit. Product signed off on 100 rpm. Low risk, but it's a global config, so please roll it out properly.",
    },
    config: {
      name: "ratelimit/api-login.json",
      consumer: "Rate limiting module in the edge proxy",
      before: { rule: "api-login", requests_per_minute: 60, action: "block", window_seconds: 60 },
      after: { rule: "api-login", requests_per_minute: 100, action: "block", window_seconds: 60 },
    },
    failure: { kind: "none" },
    offlineReview:
      "Single numeric change, 60 → 100 rpm, same action and window. Nothing structural. Risk: LOW. Still worth a canary: it's global config.",
    lesson:
      "Not every change is a trap. Staged rollouts cost a few minutes on a good change and save the day on a bad one. Rolling back a good change is also a failure.",
  },
  {
    id: "feature-file",
    title: "The Feature File",
    ticket: {
      id: "CHG-1077",
      author: "dev (Bot Management)",
      summary: "Regenerate the bot-scoring feature file after the ClickHouse permissions migration",
      description:
        "The permissions migration landed, so the feature file generator can now see more tables. Regenerated file attached. The generator runs every 5 minutes anyway, so this is business as usual.",
    },
    config: {
      name: "bot-management/features.json",
      consumer: "Bot scoring module in the edge proxy (preallocates memory for features at startup)",
      before: {
        features_count: 60,
        file_size_kb: 1180,
        source_query: "SELECT name, type FROM system.columns WHERE table = 'http_requests_features'",
        databases_visible: ["default"],
      },
      after: {
        features_count: 260,
        file_size_kb: 2390,
        source_query: "SELECT name, type FROM system.columns WHERE table = 'http_requests_features'",
        databases_visible: ["default", "r0"],
      },
    },
    failure: { kind: "crash", rate: 1 },
    offlineReview:
      "The feature count jumps 60 → 260 and the file doubles in size, while the query itself didn't change: the new database 'r0' is probably producing duplicate rows. The consumer preallocates memory for features. Risk: HIGH. Canary it on the smallest datacenter.",
    lesson:
      "Config files are code. A file that suddenly doubles in size is a signal, and a consumer with a hard limit turns it into an outage. Validate before applying, and fail stale: keep serving the last known-good file.",
    inspiredBy: {
      title: "Cloudflare outage on November 18, 2025",
      url: "https://blog.cloudflare.com/18-november-2025-outage/",
    },
  },
  {
    id: "backtracking",
    title: "Catastrophic Backtracking",
    ticket: {
      id: "CHG-1103",
      author: "sam (WAF)",
      summary: "Ship improved XSS detection rule to the managed ruleset",
      description:
        "New rule catches a JavaScript injection variant we've seen in the wild. It passed the test suite. Customers are asking for it, so let's get it out.",
    },
    config: {
      name: "waf/managed-rules/100035.json",
      consumer: "WAF rule engine (PCRE-style regex, runs on every request body)",
      before: { rule_id: "100035", action: "log", expression: "(?:<script[^>]*>)" },
      after: {
        rule_id: "100035",
        action: "block",
        expression: "(?:(?:\\\"|'|\\]|\\}|\\\\|\\d|(?:nan|infinity|true|false|null|undefined|symbol|math)|\\`|\\-|\\+)+[)]*;?((?:\\s|-|~|!|{}|\\|\\||\\+)*.*(?:.*=.*)))",
      },
    },
    failure: { kind: "slow-burn", onsetSec: 10, rampSec: 15, peak: 0.6 },
    offlineReview:
      "The new expression contains `.*(?:.*=.*)`: nested greedy wildcards, which can backtrack catastrophically on long inputs. The effect is CPU exhaustion, which builds up over time, not instantly. Risk: HIGH. Use long bake times; a short bake can look clean.",
    lesson:
      "Some failures take time to show. CPU exhaustion builds as traffic flows, so a short bake can pass a bad change. Bake long enough to see the trend, and treat regex as code that needs runtime limits.",
    inspiredBy: {
      title: "Details of the Cloudflare outage on July 2, 2019",
      url: "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/",
    },
  },
  {
    id: "regional",
    title: "Works On My Region",
    ticket: {
      id: "CHG-1150",
      author: "alex (Network)",
      summary: "Move the origin pool to the new anycast prefix",
      description:
        "Migrating origin connectivity to pool-v2 on the new prefix. It's been tested from IAD and LHR and everything looks good. The old prefix gets withdrawn next week.",
    },
    config: {
      name: "network/origin-pools.json",
      consumer: "Origin connection manager in every datacenter",
      before: { origin_pool: "pool-v1", prefix: "2a06:98c0:0::/48", announced_via: ["NA", "EU", "APAC", "LATAM", "AF"] },
      after: { origin_pool: "pool-v2", prefix: "2a06:98c0:1::/48", announced_via: ["NA", "EU", "LATAM", "AF"] },
    },
    failure: { kind: "regional", region: "APAC", rate: 0.8 },
    offlineReview:
      "The new prefix is announced in every region except APAC, and testing only covered IAD and LHR. APAC datacenters may not be able to reach origins. Risk: HIGH. Pick an APAC canary, because the default order rolls APAC out last.",
    lesson:
      "A canary only proves what it can see. Pick canaries that represent where the change could break, not just where it's quietest.",
  },
  {
    id: "below-the-gate",
    title: "Below The Gate",
    ticket: {
      id: "CHG-1188",
      author: "jo (Cache)",
      summary: "Enable query-string normalization in cache keys (v3)",
      description:
        "Sorting query parameters before computing the cache key improves hit ratio by ~4% in staging. Feature-flagged, reviewed, and tests are green.",
    },
    config: {
      name: "cache/cache-key.json",
      consumer: "Cache key builder in the edge proxy",
      before: { cache_key_version: 2, normalize_query_order: false, strip_utm_params: true },
      after: { cache_key_version: 3, normalize_query_order: true, strip_utm_params: true },
    },
    failure: { kind: "subtle", rate: 0.03 },
    offlineReview:
      "A small, feature-flagged change with a clear benefit. One thing to watch: some origins sign URLs or depend on parameter order, and they could reject reordered query strings. Risk: LOW–MEDIUM. Compare stage error rates to the baseline, not just to the gate.",
    lesson:
      "Automated gates catch big failures, not every failure. A 3% error rate stays under a 10% gate but is still an outage for someone. Compare against the baseline, not just the threshold.",
  },
];

export function levelByIndex(index: number): Level {
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, index))];
}

export function isBad(level: Level): boolean {
  return level.failure.kind !== "none";
}

/** A readable diff of a flat config, used by the co-pilot prompt. */
export function configDiff(level: Level): string {
  const { before, after } = level.config;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .map((key) => {
      const a = JSON.stringify(before[key]);
      const b = JSON.stringify(after[key]);
      if (a === b) return `  ${key}: ${a}`;
      return [a !== undefined ? `- ${key}: ${a}` : null, b !== undefined ? `+ ${key}: ${b}` : null]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}
