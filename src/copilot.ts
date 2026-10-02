// The AI co-pilot: Llama 3.3 on Workers AI, with a scripted fallback so the
// game still runs without a Cloudflare account (or with COPILOT_MODE=offline).

import { configDiff, type Level } from "./levels";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface CopilotReply {
  text: string;
  /** "llama" when Workers AI answered, "offline" when the scripted fallback did. */
  source: "llama" | "offline";
}

const PERSONA = `You are "Copilot", the AI release co-pilot in a game called Fail Small.
The player is a release engineer rolling config changes out to a fleet of 20 simulated
edge datacenters. Their score is the blast radius: % of global requests failing, times seconds.

How you behave:
- Be concise: at most 90 words, plain text, no markdown headings.
- Be concrete. Cite the config keys, datacenters and numbers you were given.
- You advise; the player decides, and automated health gates (10% errors per datacenter) roll back on their own.
- You do NOT know whether the change is actually bad. Never pretend to. Reason from the diff and the data.
- Favour small, reversible steps: canaries, longer bakes, comparing against baseline, fail-stale validation.
- Players can type: deploy, proceed, rollback, status, review. Mention them when it helps.`;

/** After a Workers AI failure, use the offline co-pilot for a while instead of retrying every message. */
const AI_RETRY_MS = 60_000;
let aiUnavailableUntil = 0;

async function runModel(env: Env, messages: { role: string; content: string }[]): Promise<string | null> {
  if ((env.COPILOT_MODE as string) === "offline" || Date.now() < aiUnavailableUntil) return null;
  try {
    const result = (await env.AI.run(MODEL, { messages, max_tokens: 300, temperature: 0.4 })) as {
      response?: string;
    };
    const text = result.response?.trim();
    return text ? text : null;
  } catch (err) {
    // Typically: not logged in during local dev, or a transient error/rate limit. Back off, then try again.
    console.warn("Workers AI unavailable, using the offline co-pilot for a minute:", err);
    aiUnavailableUntil = Date.now() + AI_RETRY_MS;
    return null;
  }
}

function levelBrief(level: Level): string {
  return `Ticket ${level.ticket.id} by ${level.ticket.author}: ${level.ticket.summary}
${level.ticket.description}
File: ${level.config.name}
Consumer: ${level.config.consumer}
Diff:
${configDiff(level)}`;
}

/** Pre-flight review of the change, before anything is deployed. */
export async function preflightReview(env: Env, level: Level, memory: string): Promise<CopilotReply> {
  const text = await runModel(env, [
    { role: "system", content: PERSONA },
    {
      role: "user",
      content: `Review this change before rollout. Point out anything risky in the diff, suggest a rollout plan
(strategy, which canary datacenter, bake time), and end with "Risk: LOW", "Risk: MEDIUM" or "Risk: HIGH".

${levelBrief(level)}

What you remember from earlier rollouts in this session:
${memory || "Nothing yet."}`,
    },
  ]);
  return text ? { text, source: "llama" } : { text: level.offlineReview, source: "offline" };
}

export interface StageReport {
  stage: number;
  totalStages: number;
  trafficOnNewConfig: number;
  baselinePct: number;
  rows: { code: string; region: string; errorPct: number; status: string }[];
}

/** Commentary after each stage's health check. */
export async function stageReview(env: Env, level: Level, report: StageReport): Promise<CopilotReply> {
  const table = report.rows.map((r) => `${r.code} (${r.region}) ${r.errorPct.toFixed(2)}% ${r.status}`).join("\n");
  const text = await runModel(env, [
    { role: "system", content: PERSONA },
    {
      role: "user",
      content: `Stage ${report.stage}/${report.totalStages} of "${level.ticket.summary}" has baked.
${report.trafficOnNewConfig}% of traffic is now on the new config. Fleet baseline error rate is ~${report.baselinePct.toFixed(2)}%.
Datacenters running the new config:
${table}

Recommend PROCEED or ROLLBACK as the first word, then explain in one or two sentences.
Compare against the baseline, not just the 10% gate.`,
    },
  ]);
  if (text) return { text, source: "llama" };

  const worst = [...report.rows].sort((a, b) => b.errorPct - a.errorPct)[0];
  const elevated = worst && worst.errorPct > report.baselinePct + 1;
  return {
    source: "offline",
    text: elevated
      ? `ROLLBACK. ${worst.code} is at ${worst.errorPct.toFixed(1)}% errors against a ~${report.baselinePct.toFixed(1)}% baseline. That's under the gate but well above normal.`
      : `PROCEED. Datacenters on the new config are within baseline (~${report.baselinePct.toFixed(1)}%). Keep watching: some failures take a while to show.`,
  };
}

/** Free-form chat, with the game state as context and recent turns as memory. */
export async function chat(env: Env, level: Level, gameContext: string, history: ChatTurn[]): Promise<CopilotReply> {
  const text = await runModel(env, [
    { role: "system", content: `${PERSONA}\n\nCurrent level:\n${levelBrief(level)}\n\nCurrent game state:\n${gameContext}` },
    ...history,
  ]);
  return text
    ? { text, source: "llama" }
    : {
        source: "offline",
        text: "I'm running in offline mode, so I can only give scripted reviews. Run `npx wrangler login` and restart `npm start` to chat with Llama 3.3. Meanwhile: deploy, proceed, rollback, status, review.",
      };
}

/** Blameless debrief at the end of a level. */
export async function debrief(env: Env, level: Level, summary: string): Promise<CopilotReply> {
  const text = await runModel(env, [
    { role: "system", content: PERSONA },
    {
      role: "user",
      content: `Write a short blameless debrief (max 90 words) of this rollout: what happened, what went well, and
one concrete thing to do differently. The hidden truth is now revealed, so you may use it.

${levelBrief(level)}

Rollout summary:
${summary}

Lesson of this level: ${level.lesson}`,
    },
  ]);
  return text ? { text, source: "llama" } : { text: level.lesson, source: "offline" };
}
