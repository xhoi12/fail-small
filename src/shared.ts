// Types shared by the agent (src/game.ts) and the React client (src/client/).
// Everything the browser renders comes through these shapes, so the client
// never sees the hidden failure mode of a level.

import type { UIMessage } from "ai";
import type { Grade, Region, RolloutPlan, Strategy } from "./sim";

export type RolloutStatus = "running" | "awaiting-decision" | "completed" | "rolled-back";

/** Whether a rollout is still in progress (as opposed to finished, either way). */
export function isActive<R extends { status: RolloutStatus }>(rollout: R | null | undefined): rollout is R {
  return rollout != null && (rollout.status === "running" || rollout.status === "awaiting-decision");
}

/** What the current stage is doing: applying → baking → checking/reviewing → deciding. */
export type StagePhase = "applying" | "baking" | "checking" | "reviewing" | "deciding";

/** One line in the rollout log (stage applied, health check, rollback, …). */
export interface GameEvent {
  id: string;
  at: number;
  text: string;
  tone: "info" | "good" | "warn" | "bad";
}

export interface StageView {
  codes: string[];
  /** This stage's share of global traffic, in %. */
  traffic: number;
}

/** The view model the agent pushes to every connected browser. */
export interface GameView {
  levels: { index: number; id: string; title: string; result: LevelResult | null }[];
  levelIndex: number;
  level: {
    title: string;
    ticket: { id: string; author: string; summary: string; description: string };
    config: { name: string; consumer: string; before: Record<string, unknown>; after: Record<string, unknown> };
    /** Revealed only once the level has been played. */
    lesson: string | null;
    inspiredBy: { title: string; url: string } | null;
  };
  plan: RolloutPlan;
  planStages: StageView[];
  bakeOptions: number[];
  failStale: boolean;
  rollout: {
    id: string;
    status: RolloutStatus;
    stageIndex: number;
    phase: StagePhase;
    /** When the current bake ends (ms since epoch), and how long it is, while baking. */
    bakeEndsAt: number | null;
    bakeTotalSec: number | null;
    stages: StageView[];
    plan: RolloutPlan;
    blast: number;
    strategy: Strategy;
    endReason: string | null;
    outcome: { grade: Grade; passed: boolean; note: string } | null;
  } | null;
  fleet: {
    code: string;
    city: string;
    region: Region;
    traffic: number;
    onNewConfig: boolean;
    rejected: boolean;
    errorPct: number;
  }[];
  copilotMode: "llama" | "offline";
}

export interface LevelResult {
  grade: Grade;
  passed: boolean;
  blast: number;
  strategy: Strategy;
}

/**
 * Custom WebSocket frames the agent sends next to the Agents SDK's own
 * protocol frames. Prefixed so they can't collide with `cf_agent_*` types.
 */
export type ServerFrame =
  | { type: "game:view"; view: GameView }
  | { type: "game:events"; events: GameEvent[] }
  | { type: "game:event"; event: GameEvent };

/** Why the server started a co-pilot turn on its own (no user message). */
export type CopilotTrigger = "preflight" | "stage-review" | "debrief";

/**
 * Chat message metadata. Server-initiated turns start with a hidden "user"
 * message that carries the prompt; the client doesn't render it.
 */
export interface MessageMetadata {
  hidden?: boolean;
  trigger?: CopilotTrigger;
  /** What the offline co-pilot says for this trigger when Workers AI isn't available. */
  offlineReply?: string;
}

export type ChatMessage = UIMessage<MessageMetadata>;

/** Co-pilot tools that change the game. They need the player's approval; the UI renders them as cards. */
export const ACTION_TOOLS = ["setRolloutPlan", "deployChange", "proceedRollout", "rollBack"] as const;
export type ActionTool = (typeof ACTION_TOOLS)[number];
