// The AI co-pilot: prompts, tools and the offline fallback.
//
// The co-pilot runs as an AIChatAgent turn (see GameSession.onChatMessage):
// Llama 3.3 on Workers AI via the AI SDK's streamText, with two kinds of tools:
//
//   - read-only tools (rollout status, fleet health, one datacenter's history,
//     past rollouts) run automatically, so the model can look before it talks;
//   - action tools (change the plan, deploy, proceed, roll back) have
//     `needsApproval`, so the player sees an Approve / Reject card first.
//
// The model never sees the level's hidden failure mode: it gets the same diff
// and metrics as the player, so it can be wrong. That's part of the game.
//
// When Workers AI isn't available (not logged in, offline, rate limited) the
// agent answers with the scripted replies at the bottom of this file instead.

import { InvalidToolInputError, NoSuchToolError, ToolCallRepairError, tool } from "ai";
import { z } from "zod";
import { configDiff, type Level } from "./levels";
import { BAKE_OPTIONS, FLEET, type RolloutPlan } from "./sim";

/** Llama 3.3 70B on Workers AI. Supports tool calling. */
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Most chat messages sent to the model; older ones stay in storage but not in the prompt. */
export const CONTEXT_MESSAGES = 24;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const PERSONA = `You are "Copilot", the AI release co-pilot in a game called Fail Small.
The player is a release engineer rolling config changes out to a fleet of 20 simulated
edge datacenters. Their score is the blast radius: % of global requests failing, times seconds.

How you behave:
- Be concise: at most 90 words, plain text, no markdown headings.
- Be concrete. Cite the config keys, datacenters and numbers you were given or looked up.
- Use your read-only tools (getRolloutStatus, getFleetHealth, getDatacenter, getPastRollouts)
  instead of guessing about the current state.
- You may propose actions with setRolloutPlan, deployChange, proceedRollout or rollBack. The
  player has to approve each one, so only propose an action when you'd stand behind it, and
  say why in one sentence.
- Automated health gates roll back on their own when any datacenter goes over 10% errors.
  Your value is spotting what the gate misses: compare against the ~0.3% baseline.
- You do NOT know whether the change is actually bad. Never pretend to. Reason from the diff and the data.
- Favour small, reversible steps: canaries, longer bakes, comparing against baseline, fail-stale validation.`;

export function systemPrompt(level: Level, gameContext: string): string {
  return `${PERSONA}

Current ticket:
${levelBrief(level)}

Current game state:
${gameContext}`;
}

function levelBrief(level: Level): string {
  return `Ticket ${level.ticket.id} by ${level.ticket.author}: ${level.ticket.summary}
${level.ticket.description}
File: ${level.config.name}
Consumer: ${level.config.consumer}
Diff:
${configDiff(level)}`;
}

// Server-initiated turns. Each one is sent as a hidden "user" message, so the
// model sees *why* it's speaking and the player only sees the answer.

export function preflightPrompt(): string {
  return `[Game] A new ticket is ready (see the system prompt). Review the change before rollout: point out
anything risky in the diff, suggest a rollout plan (strategy, which canary datacenter, bake time), and end
with "Risk: LOW", "Risk: MEDIUM" or "Risk: HIGH". If earlier rollouts are relevant, use getPastRollouts.
Don't propose actions yet.`;
}

export interface StageReport {
  stage: number;
  totalStages: number;
  trafficOnNewConfig: number;
  baselinePct: number;
  rows: { code: string; region: string; errorPct: number; status: string }[];
}

export function stageReviewPrompt(report: StageReport): string {
  const table = report.rows.map((r) => `${r.code} (${r.region}) ${r.errorPct.toFixed(2)}% ${r.status}`).join("\n");
  return `[Game] Stage ${report.stage}/${report.totalStages} has baked and passed the automatic 10% health gate.
${report.trafficOnNewConfig}% of traffic is now on the new config. Fleet baseline error rate is ~${report.baselinePct.toFixed(2)}%.
Datacenters on the new config:
${table}

Start with PROCEED or ROLLBACK, then explain in one or two sentences, comparing against the baseline.
If you recommend rolling back, also call rollBack so the player can approve it in one click.`;
}

export function debriefPrompt(level: Level, summary: string): string {
  return `[Game] The level is over. Write a short blameless debrief (max 90 words) of this rollout: what happened,
what went well, and one concrete thing to do differently. The hidden truth is now revealed, so you may use it.
Don't call any tools.

Rollout summary:
${summary}

Lesson of this level: ${level.lesson}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** What the co-pilot's tools can see and do. Implemented by GameSession. */
export interface CopilotGame {
  rolloutStatus(): Record<string, unknown>;
  fleetHealth(): Record<string, unknown>;
  datacenterHistory(code: string): Record<string, unknown>;
  pastRollouts(): string[];
  /** Action tools return a short sentence saying what happened (or why nothing did). */
  applyPlan(plan: Partial<RolloutPlan>): Promise<string>;
  startRollout(): Promise<string>;
  proceedRollout(): Promise<string>;
  rollBackRollout(reason: string): Promise<string>;
}

const DATACENTER = z.enum(FLEET.map((dc) => dc.code) as [string, ...string[]]);

export function copilotTools(game: CopilotGame, { allowActions }: { allowActions: boolean }) {
  const readOnly = {
    getRolloutStatus: tool({
      description: "The current rollout plan, rollout status, stage and blast radius so far.",
      inputSchema: z.object({}),
      execute: async () => game.rolloutStatus(),
    }),
    getFleetHealth: tool({
      description:
        "Current error rate of every datacenter, whether it runs the new config, and the fleet's baseline error rate.",
      inputSchema: z.object({}),
      execute: async () => game.fleetHealth(),
    }),
    getDatacenter: tool({
      description:
        "One datacenter's details and its error rate over the last 30 seconds, to spot trends. Pass its code, e.g. SYD.",
      // Optional so a call without a code gets a useful answer instead of a validation error.
      inputSchema: z.object({ code: DATACENTER.optional().describe("Datacenter code, e.g. SYD") }),
      execute: async ({ code }) =>
        code
          ? game.datacenterHistory(code)
          : { error: "Pass a datacenter code. Valid codes:", codes: FLEET.map((dc) => dc.code) },
    }),
    getPastRollouts: tool({
      description: "Summaries of the player's earlier rollouts in this session, newest last.",
      inputSchema: z.object({}),
      execute: async () => ({ rollouts: game.pastRollouts() }),
    }),
  };
  if (!allowActions) return readOnly;

  // Every action needs the player's approval: the co-pilot advises, the player decides.
  return {
    ...readOnly,
    setRolloutPlan: tool({
      description: "Propose a different rollout plan. Only fields you pass are changed.",
      inputSchema: z.object({
        strategy: z.enum(["big-bang", "fast", "staged"]).optional(),
        canary: DATACENTER.optional().describe("Datacenter that gets the change first"),
        bakeSec: z
          .number()
          .refine((n) => BAKE_OPTIONS.includes(n), `One of ${BAKE_OPTIONS.join(", ")}`)
          .optional()
          .describe(`Seconds each stage bakes: ${BAKE_OPTIONS.join(", ")}`),
      }),
      needsApproval: true,
      execute: async (plan) => ({ result: await game.applyPlan(plan) }),
    }),
    deployChange: tool({
      description: "Start rolling out the change with the current plan.",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => ({ result: await game.startRollout() }),
    }),
    proceedRollout: tool({
      description: "Move the rollout to its next stage. Only valid while the rollout is waiting for a decision.",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => ({ result: await game.proceedRollout() }),
    }),
    rollBack: tool({
      description: "Roll the change back everywhere, ending the rollout.",
      inputSchema: z.object({ reason: z.string().describe("One sentence: why roll back") }),
      needsApproval: true,
      execute: async ({ reason }) => ({ result: await game.rollBackRollout(reason) }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Workers AI streaming fix
// ---------------------------------------------------------------------------

/**
 * Workers AI streams each token in two fields of the same event (`response` and the
 * OpenAI-style `choices[0].delta.content`), and workers-ai-provider 4.0.0 emits both,
 * so every word shows up twice. This wraps the AI binding so that, for events carrying
 * both, only `choices[0].delta.content` is kept. Everything else passes through as is.
 */
export function dedupedAiBinding(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop, receiver) {
      if (prop !== "run") return Reflect.get(target, prop, receiver);
      return async (...args: Parameters<Ai["run"]>) => {
        const result = await (target.run as (...a: unknown[]) => Promise<unknown>)(...args);
        if (!(result instanceof ReadableStream)) return result;
        return result.pipeThrough(new TextDecoderStream()).pipeThrough(dropDuplicateText()).pipeThrough(new TextEncoderStream());
      };
    },
  });
}

/** SSE transform: in `data:` events with both text fields, drop `response`. Exported for tests. */
export function dropDuplicateText(): TransformStream<string, string> {
  let pending = "";
  const fixLine = (line: string): string => {
    if (!line.startsWith("data:")) return line;
    const json = line.slice(5).trim();
    if (!json.startsWith("{")) return line;
    try {
      const event = JSON.parse(json);
      const content = event.choices?.[0]?.delta?.content;
      // `response` can be a number for numeric tokens (e.g. 0), so test like the provider does.
      if (event.response != null && event.response !== "" && content != null && content !== "") {
        delete event.response;
        return `data: ${JSON.stringify(event)}`;
      }
    } catch {
      // Not JSON we understand; leave it alone.
    }
    return line;
  };
  return new TransformStream({
    transform(text, controller) {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) controller.enqueue(fixLine(line) + "\n");
    },
    flush(controller) {
      if (pending) controller.enqueue(fixLine(pending));
    },
  });
}

// ---------------------------------------------------------------------------
// Availability and the offline fallback
// ---------------------------------------------------------------------------

/** After a Workers AI failure, use the offline co-pilot for a while instead of failing every message. */
const AI_RETRY_MS = 60_000;
let aiUnavailableUntil = 0;

export function aiAvailable(env: Env): boolean {
  return (env.COPILOT_MODE as string) !== "offline" && Date.now() >= aiUnavailableUntil;
}

/** The model asked for a tool that doesn't exist or with arguments that don't fit. Not an outage. */
export function isToolError(err: unknown): boolean {
  return InvalidToolInputError.isInstance(err) || NoSuchToolError.isInstance(err) || ToolCallRepairError.isInstance(err);
}

export function markAiUnavailable(err: unknown): void {
  // Typically: not logged in during local dev, or a transient error / rate limit.
  console.warn("Workers AI unavailable, using the offline co-pilot for a minute:", err);
  aiUnavailableUntil = Date.now() + AI_RETRY_MS;
}

/** Scripted stage review: flags anything clearly above the fleet baseline. */
export function offlineStageReview(report: StageReport): string {
  const worst = [...report.rows].sort((a, b) => b.errorPct - a.errorPct)[0];
  const elevated = worst && worst.errorPct > report.baselinePct + 1;
  return elevated
    ? `ROLLBACK. ${worst.code} is at ${worst.errorPct.toFixed(1)}% errors against a ~${report.baselinePct.toFixed(1)}% baseline. That's under the gate but well above normal.`
    : `PROCEED. Datacenters on the new config are within baseline (~${report.baselinePct.toFixed(1)}%). Keep watching: some failures take a while to show.`;
}

export const OFFLINE_CHAT =
  "I'm in offline mode, so I can only give scripted reviews. Commands still work: deploy, proceed, rollback, " +
  "status, review. For free-form chat with Llama 3.3, run `npx wrangler login` and restart `npm start`.";
