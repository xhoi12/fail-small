// GameSession: one agent per player, built on the Cloudflare Agents SDK.
//
// It extends AIChatAgent (an Agent, so a Durable Object underneath) and owns:
//
//   - the game state (fleet, active rollout, scores, the co-pilot's memory of
//     past rollouts), persisted with setState();
//   - the chat with the co-pilot: AIChatAgent stores the messages in SQLite and
//     streams replies; onChatMessage() below decides what answers;
//   - the rollout log (game events) in its own SQLite table;
//   - the 1-second simulation tick, scheduled with scheduleEvery().
//
// Three kinds of callers reach it:
//
//   browser   → @callable() methods (deploy, proceed, ...) over WebSocket RPC,
//               plus chat messages over the AIChatAgent protocol;
//   co-pilot  → the CopilotGame methods, through the tools in copilot.ts;
//   workflow  → the plain RPC methods at the bottom (applyStage, checkHealth, ...),
//               which RolloutWorkflow calls through `this.agent`.

import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable, type Connection, type ConnectionContext } from "agents";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isToolUIPart,
  pruneMessages,
  stepCountIs,
  streamText,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import * as copilot from "./copilot";
import { LEVELS, isBad, levelByIndex, type Level } from "./levels";
import {
  isActive,
  type ChatMessage,
  type CopilotTrigger,
  type GameEvent,
  type GameView,
  type LevelResult,
  type RolloutStatus,
  type ServerFrame,
  type StagePhase,
} from "./shared";
import {
  BAKE_OPTIONS,
  DEFAULT_PLAN,
  FLEET,
  HEALTH_GATE,
  buildStages,
  configErrorRate,
  datacenter,
  failsValidation,
  scoreRollout,
  trafficShare,
  type Grade,
  type RolloutPlan,
} from "./sim";
import type { RolloutParams } from "./workflow";

const TICK_SEC = 1;
const MAX_EVENTS = 200;
const MAX_MEMORY = 10;
/** Error-rate samples kept per datacenter for the co-pilot's getDatacenter tool (one per tick). */
const HISTORY_SAMPLES = 30;
/** How long a server-initiated co-pilot turn waits for the chat to be idle before giving up. */
const STABLE_TIMEOUT_MS = 30_000;
const GRADE_ORDER: Grade[] = ["S", "A", "B", "C", "D", "F"];

interface Rollout {
  id: string;
  levelId: string;
  plan: RolloutPlan;
  failStale: boolean;
  stages: string[][];
  /** Index of the last stage that was applied (-1 before the first). */
  stageIndex: number;
  status: RolloutStatus;
  /** What the current stage is doing, for the progress display. */
  phase: StagePhase;
  /** When the current bake ends (ms since epoch), and how long it is, while baking. */
  bakeEndsAt: number | null;
  bakeTotalSec: number | null;
  startedAt: number;
  endedAt?: number;
  lastTick: number;
  /** % of global requests failing, integrated over seconds. */
  blast: number;
  endReason?: string;
  /** How this rollout was graded (the best grade per level is kept separately in `results`). */
  outcome?: { grade: Grade; passed: boolean; note: string };
}

interface DcState {
  onNewConfig: boolean;
  /** Fail-stale validation rejected the config; the datacenter kept the last known-good one. */
  rejected: boolean;
  appliedAt: number | null;
}

interface GameState {
  levelIndex: number;
  plan: RolloutPlan;
  failStale: boolean;
  dcs: Record<string, DcState>;
  rollout: Rollout | null;
  /** Best result per level id. */
  results: Record<string, LevelResult>;
  /** Short summaries of past rollouts, fed back to the co-pilot. */
  memory: string[];
  /** Id of the 1-second simulation schedule while a rollout is running. */
  tickScheduleId: string | null;
}

/** How long the last stage bakes: the "final watch" over the whole fleet before declaring success. */
function watchSec(plan: RolloutPlan): number {
  return Math.max(plan.bakeSec, 20);
}

/** What the workflow gets back from a stage's health check. */
export interface HealthCheck {
  gateTripped: boolean;
  gateReason: string;
  report: copilot.StageReport;
}

/** Name of the event the workflow waits for after each stage. */
export function decisionEvent(stageIndex: number): string {
  return `stage-${stageIndex}-decision`;
}

function freshFleet(): Record<string, DcState> {
  return Object.fromEntries(FLEET.map((dc) => [dc.code, { onNewConfig: false, rejected: false, appliedAt: null }]));
}

function freshState(): GameState {
  return {
    levelIndex: 0,
    plan: { ...DEFAULT_PLAN },
    failStale: false,
    dcs: freshFleet(),
    rollout: null,
    results: {},
    memory: [],
    tickScheduleId: null,
  };
}

function textOf(message: ChatMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * A complete, non-LLM reply (typed commands, offline co-pilot) as a UI message stream.
 * The "start" chunk matters: AIChatAgent stamps its message id on it, which lets the
 * client match the streamed reply to the persisted one instead of showing it twice.
 */
function textResponse(text: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const id = crypto.randomUUID();
      writer.write({ type: "start" });
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: text });
      writer.write({ type: "text-end", id });
      writer.write({ type: "finish" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

export class GameSession extends AIChatAgent<Env, GameState> implements copilot.CopilotGame {
  initialState = freshState();
  /** Keep the stored chat bounded; the model only ever sees the last CONTEXT_MESSAGES. */
  maxPersistedMessages = 200;

  private events: GameEvent[] = [];
  /** Per-datacenter background error rate (%), re-rolled every tick for realism. */
  private noise: Record<string, number> = {};
  /** Recent error-rate samples per datacenter. In memory only: it's a hint for the co-pilot, not game state. */
  private history: Record<string, number[]> = {};
  /** Bumped by reset(), so co-pilot turns queued before a reset don't post into the fresh chat. */
  private chatEpoch = 0;

  async onStart(): Promise<void> {
    await super.onStart();
    this.rollNoise();
    this.sql`CREATE TABLE IF NOT EXISTS game_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL)`;
    this.events = this.sql<{ body: string }>`SELECT body FROM game_events ORDER BY at, rowid`.map((row) => JSON.parse(row.body));
  }

  // -------------------------------------------------------------------------
  // Connections and pushes to the browser
  // -------------------------------------------------------------------------

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    await super.onConnect(connection, ctx);
    this.send(connection, { type: "game:events", events: this.events });
    this.send(connection, { type: "game:view", view: this.view() });
    // Everything the game does is logged, so an empty log means a brand-new player.
    if (this.events.length === 0) {
      // The welcome includes an LLM turn; don't hold up the new connection for it.
      this.ctx.waitUntil(this.welcome());
    }
  }

  /**
   * The SDK lets clients write agent state directly (useAgent's setState). Here the
   * browser must go through the @callable() actions, which validate every input, so
   * a client can't hand itself a grade or edit a running rollout.
   */
  validateStateChange(_next: GameState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("Game state is read-only for clients.");
  }

  private send(connection: Connection, frame: ServerFrame): void {
    connection.send(JSON.stringify(frame));
  }

  private push(frame: ServerFrame): void {
    this.broadcast(JSON.stringify(frame));
  }

  private pushView(): void {
    this.push({ type: "game:view", view: this.view() });
  }

  /** Persists the (mutated) game state. */
  private save(): void {
    this.setState(this.state);
  }

  /** Adds a line to the rollout log. */
  private logEvent(text: string, tone: GameEvent["tone"] = "info"): void {
    const event: GameEvent = { id: crypto.randomUUID(), at: Date.now(), text, tone };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.sql`INSERT INTO game_events (id, at, body) VALUES (${event.id}, ${event.at}, ${JSON.stringify(event)})`;
    this.sql`DELETE FROM game_events WHERE id NOT IN (SELECT id FROM game_events ORDER BY at DESC, rowid DESC LIMIT ${MAX_EVENTS})`;
    this.push({ type: "game:event", event });
  }

  // -------------------------------------------------------------------------
  // The co-pilot (AIChatAgent)
  // -------------------------------------------------------------------------

  /**
   * Answers every chat turn: messages the player types, approvals of the
   * co-pilot's proposed actions, and the turns the game starts on its own
   * (pre-flight review, stage reviews, debrief) through copilotTurn().
   */
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions): Promise<Response | undefined> {
    const last = this.messages.at(-1) as ChatMessage | undefined;
    const meta = last?.metadata;

    // 1. Short commands typed by the player ("deploy", "rollback", ...) act right away,
    //    with or without the LLM. Typing the command is the approval.
    if (last?.role === "user" && !meta?.hidden) {
      const reply = await this.runCommand(textOf(last));
      if (reply !== null) return textResponse(reply);
    }

    // 2. No Workers AI: scripted replies.
    if (!copilot.aiAvailable(this.env)) {
      return textResponse(meta?.hidden ? (meta.offlineReply ?? "") : copilot.OFFLINE_CHAT);
    }

    // 3. Llama 3.3 with tools. The pre-flight review and the debrief only get the
    //    read-only tools: there's nothing to act on yet, or anymore.
    const allowActions = meta?.trigger !== "preflight" && meta?.trigger !== "debrief";
    const workersai = createWorkersAI({ binding: copilot.dedupedAiBinding(this.env.AI) });
    const result = streamText({
      model: workersai(copilot.MODEL, { sessionAffinity: this.sessionAffinity }),
      system: copilot.systemPrompt(this.level, this.gameContext()),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages.slice(-copilot.CONTEXT_MESSAGES)),
        toolCalls: "before-last-2-messages",
      }),
      tools: copilot.copilotTools(this, { allowActions }),
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
      onError: ({ error }) => {
        // A malformed tool call goes back to the model as a tool error; only a failing API means offline.
        if (!copilot.isToolError(error)) copilot.markAiUnavailable(error);
      },
    });
    return result.toUIMessageStreamResponse({
      onError: (error) =>
        copilot.isToolError(error)
          ? `Tool call failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
          : "The co-pilot couldn't reach Workers AI, so it's using offline mode for a minute.",
    });
  }

  /** Handles a typed command. Returns the reply, or null if the text isn't a command. */
  private async runCommand(raw: string): Promise<string | null> {
    const text = raw.trim().toLowerCase();
    // "deploy" is a command; "deploy now or wait?" is a question for the co-pilot.
    if (text.includes("?") || text.split(/\s+/).length > 4) return null;
    if (/^(deploy|ship|go live)\b/.test(text)) return this.startRollout();
    if (/^(proceed|continue|next stage)\b/.test(text)) return this.proceedRollout();
    if (/^(roll ?back|abort|revert)\b/.test(text)) return this.rollBackRollout("You typed rollback.");
    if (/^status\b/.test(text)) return this.gameContext();
    // Online, "review" is a normal question for Llama; offline, it repeats the scripted review.
    if (/^review\b/.test(text) && !copilot.aiAvailable(this.env)) return this.level.offlineReview;
    return null;
  }

  /**
   * Starts a co-pilot turn without a player message: a hidden "user" message
   * carries the prompt, and saveMessages() runs onChatMessage() for it.
   * Resolves when the reply is done, or skipped because the chat stayed busy or
   * the game moved on while it waited (`stillRelevant`, or a reset).
   *
   * Never await this from inside a chat turn (a tool or a typed command): the
   * turn would wait for itself. Use queueCopilotTurn() there instead.
   */
  private async copilotTurn(
    trigger: CopilotTrigger,
    prompt: string,
    offlineReply: string,
    stillRelevant: () => boolean = () => true,
  ): Promise<void> {
    const epoch = this.chatEpoch;
    await this.supersedePendingApprovals();
    if (!(await this.waitUntilStable({ timeout: STABLE_TIMEOUT_MS }))) return;
    if (epoch !== this.chatEpoch || !stillRelevant()) return;
    await this.saveMessages((messages) => [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
        metadata: { hidden: true, trigger, offlineReply },
      } satisfies ChatMessage,
    ]);
  }

  private queueCopilotTurn(trigger: CopilotTrigger, prompt: string, offlineReply: string): void {
    this.ctx.waitUntil(this.copilotTurn(trigger, prompt, offlineReply));
  }

  /**
   * When the player acts with the buttons (or the game moves on), any action the
   * co-pilot proposed and nobody answered is stale. Mark it declined so its card
   * disappears and the chat isn't left waiting on it.
   */
  private async supersedePendingApprovals(): Promise<void> {
    if (!this.hasPendingInteraction()) return;
    this.resetTurnState();
    const messages = (this.messages as ChatMessage[]).map((message) =>
      message.role !== "assistant"
        ? message
        : {
            ...message,
            parts: message.parts.map((part) =>
              isToolUIPart(part) && part.state === "approval-requested"
                ? {
                    ...part,
                    state: "output-denied" as const,
                    approval: { ...part.approval, approved: false as const, reason: "Superseded: the rollout moved on." },
                  }
                : part,
            ),
          },
    );
    await this.persistMessages(messages);
  }

  private preflight(): void {
    this.queueCopilotTurn("preflight", copilot.preflightPrompt(), this.level.offlineReview);
  }

  // -------------------------------------------------------------------------
  // CopilotGame: what the co-pilot's tools can see and do
  // -------------------------------------------------------------------------

  rolloutStatus(): Record<string, unknown> {
    const { plan, rollout, failStale } = this.state;
    return {
      level: this.level.title,
      plan,
      failStale,
      rollout: rollout && {
        status: rollout.status,
        stage: `${rollout.stageIndex + 1}/${rollout.stages.length}`,
        trafficOnNewConfigPct: trafficShare(FLEET.filter((dc) => this.state.dcs[dc.code].onNewConfig).map((dc) => dc.code)),
        blastRadius: Number(rollout.blast.toFixed(2)),
        endReason: rollout.endReason ?? null,
      },
    };
  }

  fleetHealth(): Record<string, unknown> {
    const now = Date.now();
    return {
      baselinePct: Number(this.baseline().toFixed(2)),
      healthGatePct: HEALTH_GATE * 100,
      datacenters: FLEET.map((dc) => ({
        code: dc.code,
        region: dc.region,
        trafficPct: dc.traffic,
        onNewConfig: this.state.dcs[dc.code].onNewConfig,
        keptLastKnownGood: this.state.dcs[dc.code].rejected,
        errorPct: Number(this.errorPct(dc.code, now).toFixed(2)),
      })),
    };
  }

  datacenterHistory(code: string): Record<string, unknown> {
    const dc = datacenter(code);
    return {
      ...dc,
      onNewConfig: this.state.dcs[code].onNewConfig,
      errorPctNow: Number(this.errorPct(code, Date.now()).toFixed(2)),
      errorPctLast30s: (this.history[code] ?? []).map((pct) => Number(pct.toFixed(2))),
    };
  }

  pastRollouts(): string[] {
    return this.state.memory;
  }

  async applyPlan(plan: Partial<RolloutPlan>): Promise<string> {
    if (isActive(this.state.rollout)) return "Can't change the plan during a rollout.";
    if (typeof plan !== "object" || plan === null) return "No plan given.";
    const next = { ...this.state.plan };
    if (plan.strategy && ["big-bang", "fast", "staged"].includes(plan.strategy)) next.strategy = plan.strategy;
    if (plan.canary && FLEET.some((dc) => dc.code === plan.canary)) next.canary = plan.canary;
    if (plan.bakeSec && BAKE_OPTIONS.includes(Number(plan.bakeSec))) next.bakeSec = Number(plan.bakeSec);
    this.state.plan = next;
    this.save();
    this.pushView();
    return `Plan is now ${next.strategy}, canary ${next.canary}, bake ${next.bakeSec}s.`;
  }

  async startRollout(): Promise<string> {
    if (isActive(this.state.rollout)) return "A rollout is already in progress.";
    const plan = { ...this.state.plan };
    const now = Date.now();
    const rollout: Rollout = {
      id: crypto.randomUUID(),
      levelId: this.level.id,
      plan,
      failStale: this.state.failStale,
      stages: buildStages(plan),
      stageIndex: -1,
      status: "running",
      phase: "applying",
      bakeEndsAt: null,
      bakeTotalSec: null,
      startedAt: now,
      lastTick: now,
      blast: 0,
    };
    const previous = this.state.rollout;
    this.state.dcs = freshFleet();
    this.state.rollout = rollout;
    // Start ticking before the workflow does, so finish() always finds the schedule to cancel,
    // however quickly the rollout ends.
    const ticker = await this.scheduleEvery(TICK_SEC, "simulationTick");
    this.state.tickScheduleId = ticker.id;
    this.save();

    try {
      // The Workflow drives the stages and calls back into this agent (see workflow.ts).
      await this.runWorkflow<RolloutParams>(
        "ROLLOUT_WORKFLOW",
        {
          rolloutId: rollout.id,
          stageCount: rollout.stages.length,
          bakeSec: plan.bakeSec,
          watchSec: watchSec(plan),
        },
        { id: rollout.id, metadata: { level: this.level.id, strategy: plan.strategy } },
      );
    } catch (err) {
      // Don't leave a rollout "running" with nothing driving it.
      console.error("Failed to start the rollout workflow:", err);
      this.state.rollout = previous;
      await this.stopTicker();
      this.pushView();
      this.logEvent("The rollout couldn't start. Nothing was changed; try deploying again.", "bad");
      return "The rollout couldn't start. Nothing was changed.";
    }

    const stageText = rollout.stages
      .map((codes, i) => `${i + 1}) ${codes.length === 1 ? codes[0] : `${codes.length} DCs`} → ${trafficShare(rollout.stages.slice(0, i + 1).flat())}%`)
      .join("  ");
    this.logEvent(`Rollout started (${plan.strategy}, bake ${plan.bakeSec}s). Stages: ${stageText}`);
    this.pushView();
    return `Deploying: ${plan.strategy} rollout, canary ${plan.canary}, bake ${plan.bakeSec}s.`;
  }

  async proceedRollout(): Promise<string> {
    const { rollout } = this.state;
    if (!rollout || rollout.status !== "awaiting-decision") {
      return "Nothing to proceed with: the rollout isn't waiting for a decision.";
    }
    rollout.status = "running";
    rollout.phase = "applying";
    this.save();
    this.pushView();
    try {
      await this.sendWorkflowEvent("ROLLOUT_WORKFLOW", rollout.id, {
        type: decisionEvent(rollout.stageIndex),
        payload: { action: "proceed" },
      });
    } catch (err) {
      console.error("Failed to send the proceed decision:", err);
      if (rollout === this.state.rollout && rollout.status === "running") {
        rollout.status = "awaiting-decision";
        rollout.phase = "deciding";
      }
      this.save();
      this.pushView();
      return "Couldn't reach the rollout to proceed. Try again.";
    }
    const last = rollout.stageIndex === rollout.stages.length - 1;
    return last ? "Shipping it." : `Proceeding to stage ${rollout.stageIndex + 2}.`;
  }

  async rollBackRollout(reason: string): Promise<string> {
    const { rollout } = this.state;
    if (!isActive(rollout)) return "There's no active rollout to roll back.";
    await this.rollback(rollout.id, "player", reason || "Rolled back.");
    try {
      await this.terminateWorkflow(rollout.id);
    } catch {
      // Already finished. Every workflow step also checks the rollout id, so a stale instance can't act.
    }
    return "Rolled back.";
  }

  // -------------------------------------------------------------------------
  // Player actions: @callable() methods the browser invokes over WebSocket RPC
  // -------------------------------------------------------------------------

  @callable()
  async updatePlan(plan: Partial<RolloutPlan>): Promise<void> {
    await this.applyPlan(plan);
  }

  // The buttons. Using one means any action the co-pilot proposed is now moot.

  @callable()
  async deploy(): Promise<void> {
    if (isActive(this.state.rollout)) return this.logEvent("A rollout is already in progress.", "warn");
    await this.supersedePendingApprovals();
    await this.startRollout();
  }

  @callable()
  async proceed(): Promise<void> {
    if (this.state.rollout?.status !== "awaiting-decision") {
      return this.logEvent("Nothing to proceed with: the rollout isn't waiting for a decision.", "warn");
    }
    await this.supersedePendingApprovals();
    const reply = await this.proceedRollout();
    if (reply.startsWith("Couldn't")) this.logEvent(reply, "warn");
  }

  @callable()
  async rollbackNow(): Promise<void> {
    if (!isActive(this.state.rollout)) return this.logEvent("There's no active rollout to roll back.", "warn");
    await this.supersedePendingApprovals();
    await this.rollBackRollout("You rolled it back.");
  }

  @callable()
  async setFailStale(raw: boolean): Promise<void> {
    const on = Boolean(raw);
    if (isActive(this.state.rollout)) return this.logEvent("Finish or roll back the current rollout before changing fail-stale.", "warn");
    this.state.failStale = on;
    this.save();
    this.pushView();
    this.logEvent(
      on
        ? "Fail-stale is ON: datacenters validate new configs and keep serving the last known-good one if validation fails."
        : "Fail-stale is OFF: datacenters apply whatever config they receive.",
    );
  }

  @callable()
  async selectLevel(raw: number): Promise<void> {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= LEVELS.length) return;
    if (isActive(this.state.rollout)) return this.logEvent("Finish or roll back the current rollout first.", "warn");
    await this.supersedePendingApprovals();
    this.state.levelIndex = index;
    this.state.rollout = null;
    this.state.dcs = freshFleet();
    this.save();
    this.pushView();
    this.logEvent(`Level ${index + 1}: ${this.level.title}. New ticket: ${this.level.ticket.id}.`);
    this.preflight();
  }

  @callable()
  async reset(): Promise<void> {
    if (isActive(this.state.rollout)) {
      try {
        await this.terminateWorkflow(this.state.rollout.id);
      } catch {
        // Already finished.
      }
    }
    await this.stopTicker();
    this.setState(freshState());
    this.chatEpoch++;
    this.resetTurnState();
    await this.persistMessages([]);
    this.events = [];
    this.history = {};
    this.sql`DELETE FROM game_events`;
    this.push({ type: "game:events", events: [] });
    this.pushView();
    await this.welcome();
  }

  private async welcome(): Promise<void> {
    this.logEvent(
      "Welcome to Fail Small. You're the release engineer. Each level is a config change: pick a rollout plan, " +
        "deploy it, and decide at every stage whether to proceed or roll back. Your score is the blast radius. Keep it small.",
    );
    this.preflight();
  }

  // -------------------------------------------------------------------------
  // View model and context
  // -------------------------------------------------------------------------

  private get level(): Level {
    return levelByIndex(this.state.levelIndex);
  }

  /** Error rate (%) currently observed in a datacenter: background noise plus config-induced errors. */
  private errorPct(code: string, now: number): number {
    const config = this.configErrorPct(code, now);
    // Background noise only applies to requests the config isn't already failing.
    return config + this.noise[code] * (1 - config / 100);
  }

  private configErrorPct(code: string, now: number): number {
    const dc = this.state.dcs[code];
    if (!dc.onNewConfig || dc.appliedAt === null) return 0;
    return configErrorRate(this.level.failure, datacenter(code), (now - dc.appliedAt) / 1000) * 100;
  }

  private baseline(): number {
    return Object.values(this.noise).reduce((a, b) => a + b, 0) / FLEET.length;
  }

  private view(): GameView {
    const now = Date.now();
    const { rollout } = this.state;
    const ended = rollout !== null && !isActive(rollout);
    return {
      levels: LEVELS.map((l, i) => ({ index: i, id: l.id, title: l.title, result: this.state.results[l.id] ?? null })),
      levelIndex: this.state.levelIndex,
      level: {
        title: this.level.title,
        ticket: this.level.ticket,
        config: this.level.config,
        // Only revealed once the level has been played.
        lesson: ended ? this.level.lesson : null,
        inspiredBy: ended ? (this.level.inspiredBy ?? null) : null,
      },
      plan: this.state.plan,
      planStages: buildStages(this.state.plan).map((codes) => ({ codes, traffic: trafficShare(codes) })),
      bakeOptions: BAKE_OPTIONS,
      failStale: this.state.failStale,
      rollout: rollout && {
        id: rollout.id,
        status: rollout.status,
        stageIndex: rollout.stageIndex,
        phase: rollout.phase ?? "applying",
        bakeEndsAt: rollout.bakeEndsAt ?? null,
        bakeTotalSec: rollout.bakeTotalSec ?? null,
        stages: rollout.stages.map((codes) => ({ codes, traffic: trafficShare(codes) })),
        plan: rollout.plan,
        blast: rollout.blast,
        strategy: rollout.plan.strategy,
        endReason: rollout.endReason ?? null,
        outcome: rollout.outcome ?? null,
      },
      fleet: FLEET.map((dc) => ({
        ...dc,
        onNewConfig: this.state.dcs[dc.code].onNewConfig,
        rejected: this.state.dcs[dc.code].rejected,
        errorPct: this.errorPct(dc.code, now),
      })),
      copilotMode: copilot.aiAvailable(this.env) ? "llama" : "offline",
    };
  }

  /** A plain-text summary of the game for the co-pilot's system prompt (and the "status" command). */
  private gameContext(): string {
    const now = Date.now();
    const { plan, rollout, failStale } = this.state;
    const lines = [
      `Plan: ${plan.strategy}, canary ${plan.canary}, bake ${plan.bakeSec}s. Fail-stale validation: ${failStale ? "on" : "off"}.`,
    ];
    if (rollout) {
      const onNew = FLEET.filter((dc) => this.state.dcs[dc.code].onNewConfig).map((dc) => dc.code);
      lines.push(
        `Rollout ${rollout.status}, stage ${rollout.stageIndex + 1}/${rollout.stages.length}, ` +
          `${trafficShare(onNew)}% of traffic on the new config, blast radius so far ${rollout.blast.toFixed(1)} %·s.`,
      );
      const elevated = FLEET.map((dc) => ({ code: dc.code, pct: this.errorPct(dc.code, now) })).filter((d) => d.pct > 0.5);
      if (elevated.length) lines.push(`Elevated errors: ${elevated.map((d) => `${d.code} ${d.pct.toFixed(1)}%`).join(", ")}.`);
    } else {
      lines.push("No rollout yet for this level.");
    }
    if (this.state.memory.length) lines.push(`Earlier rollouts on record: ${this.state.memory.length}.`);
    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Simulation tick
  // -------------------------------------------------------------------------

  private rollNoise(): void {
    for (const dc of FLEET) this.noise[dc.code] = 0.1 + Math.random() * 0.3;
  }

  /** Accumulates blast radius since the last tick. */
  private tick(): void {
    const { rollout } = this.state;
    if (!isActive(rollout)) return;
    const now = Date.now();
    const dt = (now - rollout.lastTick) / 1000;
    let failingPct = 0;
    for (const dc of FLEET) failingPct += (dc.traffic * this.configErrorPct(dc.code, now)) / 100;
    rollout.blast += failingPct * dt;
    rollout.lastTick = now;
  }

  /** Runs every second while a rollout is active (scheduled with scheduleEvery). */
  async simulationTick(): Promise<void> {
    if (!isActive(this.state.rollout)) return this.stopTicker();
    this.rollNoise();
    this.tick();
    const now = Date.now();
    for (const dc of FLEET) {
      const samples = (this.history[dc.code] ??= []);
      samples.push(this.errorPct(dc.code, now));
      if (samples.length > HISTORY_SAMPLES) samples.shift();
    }
    this.save();
    this.pushView();
  }

  private async stopTicker(): Promise<void> {
    const id = this.state.tickScheduleId;
    if (!id) return;
    await this.cancelSchedule(id);
    this.state.tickScheduleId = null;
    this.save();
  }

  // -------------------------------------------------------------------------
  // RPC methods called by RolloutWorkflow. Each one checks the rollout id, so
  // retried or stale workflow steps are harmless.
  // -------------------------------------------------------------------------

  private activeRollout(rolloutId: string): Rollout | null {
    const { rollout } = this.state;
    return isActive(rollout) && rollout.id === rolloutId ? rollout : null;
  }

  async applyStage(rolloutId: string, stageIndex: number): Promise<boolean> {
    const rollout = this.activeRollout(rolloutId);
    if (!rollout) return false;
    this.tick();
    const now = Date.now();
    const codes = rollout.stages[stageIndex];
    // With fail-stale on, a datacenter validates the config first and keeps the last known-good one if it fails.
    const validate = rollout.failStale && failsValidation(this.level.failure);
    for (const code of codes) {
      const dc = this.state.dcs[code];
      if (dc.onNewConfig || dc.rejected) continue; // idempotent on retry
      if (validate) {
        dc.rejected = true;
      } else {
        dc.onNewConfig = true;
        dc.appliedAt = now;
      }
    }
    rollout.stageIndex = stageIndex;
    rollout.status = "running";
    rollout.phase = "baking";
    const last = stageIndex === rollout.stages.length - 1;
    rollout.bakeTotalSec = last ? watchSec(rollout.plan) : rollout.plan.bakeSec;
    rollout.bakeEndsAt = now + rollout.bakeTotalSec * 1000;
    this.save();
    this.pushView();
    const cumulative = trafficShare(rollout.stages.slice(0, stageIndex + 1).flat());
    this.logEvent(
      `Stage ${stageIndex + 1}/${rollout.stages.length}: config applied to ${codes.join(", ")}. ${cumulative}% of traffic now targeted.` +
        (validate ? " Fail-stale validation REJECTED it: those datacenters kept the last known-good config." : ""),
      validate ? "good" : "info",
    );
    return true;
  }

  async checkHealth(rolloutId: string, stageIndex: number): Promise<HealthCheck | null> {
    const rollout = this.activeRollout(rolloutId);
    if (!rollout) return null;
    this.tick();
    const now = Date.now();
    const codes = rollout.stages.slice(0, stageIndex + 1).flat();
    const rows = codes.map((code) => {
      const dc = this.state.dcs[code];
      return {
        code,
        region: datacenter(code).region,
        errorPct: this.errorPct(code, now),
        status: dc.rejected ? "kept last known-good (validation failed)" : "on new config",
      };
    });
    const offenders = rows.filter((r) => r.errorPct / 100 > HEALTH_GATE);
    const baseline = this.baseline();
    // Passed the gate: the co-pilot reviews the stage next (see copilotStageReview).
    rollout.phase = offenders.length ? "checking" : "reviewing";
    rollout.bakeEndsAt = null;
    this.save();
    this.pushView();
    if (offenders.length === 0) {
      const worst = rows.reduce((a, b) => (b.errorPct > a.errorPct ? b : a));
      this.logEvent(
        `Stage ${stageIndex + 1} health check passed the ${HEALTH_GATE * 100}% gate. Worst: ${worst.code} at ${worst.errorPct.toFixed(1)}% (baseline ~${baseline.toFixed(1)}%).`,
      );
    }
    return {
      gateTripped: offenders.length > 0,
      gateReason:
        offenders
          .slice(0, 4)
          .map((r) => `${r.code} at ${r.errorPct.toFixed(1)}%`)
          .join(", ") + (offenders.length > 4 ? ` and ${offenders.length - 4} more datacenters` : ""),
      report: {
        stage: stageIndex + 1,
        totalStages: rollout.stages.length,
        trafficOnNewConfig: trafficShare(codes.filter((c) => this.state.dcs[c].onNewConfig)),
        baselinePct: baseline,
        rows,
      },
    };
  }

  /** The co-pilot reviews the stage. Awaited, so its advice lands before the player is asked to decide. */
  async copilotStageReview(rolloutId: string, report: copilot.StageReport): Promise<void> {
    const stillActive = () => this.activeRollout(rolloutId) !== null;
    if (!stillActive()) return;
    await this.copilotTurn("stage-review", copilot.stageReviewPrompt(report), copilot.offlineStageReview(report), stillActive);
  }

  async awaitDecision(rolloutId: string, stageIndex: number): Promise<void> {
    const rollout = this.activeRollout(rolloutId);
    if (!rollout) return;
    rollout.status = "awaiting-decision";
    rollout.phase = "deciding";
    this.save();
    this.pushView();
    const final = stageIndex === rollout.stages.length - 1;
    this.logEvent(
      final
        ? "The whole fleet is on the new config and the final watch is over. Your call: proceed to mark it shipped, or roll back."
        : `Your call: proceed to stage ${stageIndex + 2}, or roll back.`,
    );
  }

  async rollback(rolloutId: string, cause: "gate" | "player" | "timeout", detail: string): Promise<void> {
    const rollout = this.activeRollout(rolloutId);
    if (!rollout) return;
    this.tick();
    this.state.dcs = freshFleet();
    rollout.status = "rolled-back";
    rollout.endedAt = Date.now();
    rollout.endReason =
      cause === "gate" ? `Health gate tripped: ${detail}` : cause === "timeout" ? `Timed out: ${detail}` : detail;
    this.logEvent(cause === "gate" ? `Automatic rollback. Health gate tripped: ${detail}.` : `Rolled back. ${detail}`, "warn");
    await this.finish(false);
  }

  async completeRollout(rolloutId: string): Promise<void> {
    const rollout = this.activeRollout(rolloutId);
    if (!rollout) return;
    this.tick();
    const allRejected = FLEET.every((dc) => this.state.dcs[dc.code].rejected);
    rollout.status = "completed";
    rollout.endedAt = Date.now();
    rollout.endReason = allRejected
      ? "Rollout finished, but every datacenter rejected the config and kept the last known-good one."
      : "Rollout reached 100% and passed the final watch.";
    this.logEvent(rollout.endReason, allRejected ? "good" : "info");
    await this.finish(!allRejected);
  }

  /** Grades the rollout, records it, and asks the co-pilot for a debrief. */
  private async finish(shipped: boolean): Promise<void> {
    const rollout = this.state.rollout!;
    const level = this.level;
    const validated = rollout.failStale && failsValidation(level.failure);
    const outcome = scoreRollout({ bad: isBad(level), shipped, blast: rollout.blast, strategy: rollout.plan.strategy, validated });
    if (validated && outcome.passed) {
      outcome.note += " Fail-stale validation kept the bad config from ever serving traffic.";
    }
    rollout.outcome = { grade: outcome.grade, passed: outcome.passed, note: outcome.note };

    const previous = this.state.results[level.id];
    if (!previous || GRADE_ORDER.indexOf(outcome.grade) < GRADE_ORDER.indexOf(previous.grade)) {
      this.state.results[level.id] = {
        grade: outcome.grade,
        passed: outcome.passed,
        blast: outcome.blast,
        strategy: rollout.plan.strategy,
      };
    }

    // The co-pilot's memory: fed back through getPastRollouts on later levels.
    const { plan } = rollout;
    const summary =
      `${level.title}: ${plan.strategy} rollout, canary ${plan.canary}, bake ${plan.bakeSec}s, fail-stale ${rollout.failStale ? "on" : "off"}. ` +
      `Ended at stage ${rollout.stageIndex + 1}/${rollout.stages.length}: ${rollout.endReason} ` +
      `The change was ${isBad(level) ? "bad" : "good"}. Blast radius ${outcome.blast.toFixed(1)} %·s, grade ${outcome.grade}.`;
    this.state.memory.push(summary);
    if (this.state.memory.length > MAX_MEMORY) this.state.memory.shift();
    this.save();
    await this.stopTicker();
    this.pushView();

    this.logEvent(
      `${outcome.passed ? "Level passed" : "Level failed"}. Grade ${outcome.grade}, blast radius ${outcome.blast.toFixed(1)} %·s. ${outcome.note} The change was ${isBad(level) ? "bad" : "good"}.`,
      outcome.passed ? "good" : "bad",
    );
    // Queued, not awaited: finish() can run inside a chat turn (the rollBack tool, a typed "rollback").
    this.queueCopilotTurn("debrief", copilot.debriefPrompt(level, summary), level.lesson);
  }
}
