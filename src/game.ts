// GameSession: one agent per player, built on the Cloudflare Agents SDK (a Durable
// Object underneath). It owns all game state (the fleet, the active rollout, scores
// and the co-pilot's memory) as persisted agent state, keeps chat history in the
// agent's SQLite database, runs the 1-second simulation tick with scheduleEvery(),
// and pushes updates to the browser over the agent's WebSocket connections.
//
// The browser calls the @callable() methods (deploy, proceed, chat, ...) over
// WebSocket RPC. The RolloutWorkflow, started with runWorkflow(), drives each
// rollout by calling the plain RPC methods at the bottom of this file.

import { Agent, callable, type Connection } from "agents";
import * as copilot from "./copilot";
import { LEVELS, isBad, levelByIndex, type Level } from "./levels";
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
  type Strategy,
} from "./sim";
import type { RolloutParams } from "./workflow";

const TICK_SEC = 1;
const MAX_MESSAGES = 200;
const MAX_MEMORY = 10;
const GRADE_ORDER: Grade[] = ["S", "A", "B", "C", "D", "F"];

type RolloutStatus = "running" | "awaiting-decision" | "completed" | "rolled-back";

interface Rollout {
  id: string;
  levelId: string;
  plan: RolloutPlan;
  failStale: boolean;
  stages: string[][];
  /** Index of the last stage that was applied (-1 before the first). */
  stageIndex: number;
  status: RolloutStatus;
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

interface LevelResult {
  grade: Grade;
  passed: boolean;
  blast: number;
  strategy: Strategy;
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

export interface ChatMessage {
  id: string;
  role: "user" | "copilot" | "system";
  text: string;
  at: number;
  source?: "llama" | "offline";
  tone?: "info" | "good" | "warn" | "bad";
}

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

function isActive(rollout: Rollout | null): rollout is Rollout {
  return rollout !== null && (rollout.status === "running" || rollout.status === "awaiting-decision");
}

export class GameSession extends Agent<Env, GameState> {
  initialState = freshState();

  private messages: ChatMessage[] = [];
  /** Per-datacenter background error rate (%), re-rolled every tick for realism. */
  private noise: Record<string, number> = {};
  private copilotSource: "llama" | "offline" | null = null;
  private welcomed = false;

  async onStart(): Promise<void> {
    this.rollNoise();
    this.sql`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL)`;
    this.messages = this.sql<{ body: string }>`SELECT body FROM messages ORDER BY at, rowid`.map((row) => JSON.parse(row.body));
    this.welcomed = this.messages.length > 0;
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  /** The browser renders our own view model, so skip the SDK's raw state sync. */
  shouldSendProtocolMessages(): boolean {
    return false;
  }

  async onConnect(connection: Connection): Promise<void> {
    connection.send(JSON.stringify({ type: "messages", messages: this.messages }));
    connection.send(JSON.stringify(this.snapshot()));
    if (!this.welcomed) {
      this.welcomed = true;
      // The welcome includes an LLM call; don't hold up the new connection for it.
      this.ctx.waitUntil(this.welcome());
    }
  }

  private push(payload: unknown): void {
    this.broadcast(JSON.stringify(payload));
  }

  /** Persists the (mutated) game state. */
  private save(): void {
    this.setState(this.state);
  }

  private async post(message: Omit<ChatMessage, "id" | "at">): Promise<void> {
    const full: ChatMessage = { ...message, id: crypto.randomUUID(), at: Date.now() };
    if (full.source) this.copilotSource = full.source;
    this.messages.push(full);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.sql`INSERT INTO messages (id, at, body) VALUES (${full.id}, ${full.at}, ${JSON.stringify(full)})`;
    this.sql`DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY at DESC, rowid DESC LIMIT ${MAX_MESSAGES})`;
    this.push({ type: "message", message: full });
  }

  private system(text: string, tone: ChatMessage["tone"] = "info"): Promise<void> {
    return this.post({ role: "system", text, tone });
  }

  /** Runs a co-pilot call with a typing indicator and posts the reply. */
  private async withCopilot(call: () => Promise<copilot.CopilotReply>): Promise<void> {
    this.push({ type: "typing", on: true });
    try {
      const reply = await call();
      await this.post({ role: "copilot", text: reply.text, source: reply.source });
    } finally {
      this.push({ type: "typing", on: false });
    }
  }

  // -------------------------------------------------------------------------
  // View model sent to the browser
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

  private snapshot() {
    const now = Date.now();
    const { rollout } = this.state;
    const ended = rollout && !isActive(rollout);
    return {
      type: "state",
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
        stages: rollout.stages.map((codes) => ({ codes, traffic: trafficShare(codes) })),
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
      copilotSource: this.copilotSource,
    };
  }

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
    if (this.state.memory.length) lines.push(`Earlier rollouts:\n${this.state.memory.join("\n")}`);
    return lines.join("\n");
  }

  private async welcome(): Promise<void> {
    await this.system(
      "Welcome to Fail Small. You're the release engineer. Each level is a config change: pick a rollout plan, " +
        "deploy it, and decide at every stage whether to proceed or roll back. Your score is the blast radius. Keep it small.",
    );
    await this.withCopilot(() => copilot.preflightReview(this.env, this.level, this.state.memory.join("\n")));
  }

  // -------------------------------------------------------------------------
  // Player actions: @callable() methods the browser invokes over WebSocket RPC
  // -------------------------------------------------------------------------

  @callable()
  async chat(raw: string): Promise<void> {
    const text = String(raw ?? "").slice(0, 1000);
    if (!text.trim()) return;
    await this.post({ role: "user", text });
    const command = text.trim().toLowerCase();
    // "deploy" is a command; "deploy now or wait?" is a question for the co-pilot.
    const isCommand = (pattern: RegExp) => pattern.test(command) && !command.includes("?");
    if (isCommand(/^(deploy|ship|start|go live)\b/)) return this.deploy();
    if (isCommand(/^(proceed|continue|next stage|yes)\b/)) return this.proceed();
    if (isCommand(/^(roll ?back|abort|revert|stop)\b/)) return this.rollbackNow();
    if (isCommand(/^status\b/)) return this.system(this.gameContext());
    if (isCommand(/^review\b/)) {
      return this.withCopilot(() => copilot.preflightReview(this.env, this.level, this.state.memory.join("\n")));
    }

    const history: copilot.ChatTurn[] = this.messages
      .filter((m) => m.role !== "system")
      .slice(-10)
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
    await this.withCopilot(() => copilot.chat(this.env, this.level, this.gameContext(), history));
  }

  @callable()
  async updatePlan(plan: Partial<RolloutPlan>): Promise<void> {
    if (isActive(this.state.rollout) || typeof plan !== "object" || plan === null) return;
    const next = { ...this.state.plan };
    if (plan.strategy && ["big-bang", "fast", "staged"].includes(plan.strategy)) next.strategy = plan.strategy;
    if (plan.canary && FLEET.some((dc) => dc.code === plan.canary)) next.canary = plan.canary;
    if (plan.bakeSec && BAKE_OPTIONS.includes(Number(plan.bakeSec))) next.bakeSec = Number(plan.bakeSec);
    this.state.plan = next;
    this.save();
    this.push(this.snapshot());
  }

  @callable()
  async setFailStale(raw: boolean): Promise<void> {
    const on = Boolean(raw);
    if (isActive(this.state.rollout)) return this.system("Finish or roll back the current rollout before changing fail-stale.", "warn");
    this.state.failStale = on;
    this.save();
    this.push(this.snapshot());
    await this.system(
      on
        ? "Fail-stale is ON: datacenters validate new configs and keep serving the last known-good one if validation fails."
        : "Fail-stale is OFF: datacenters apply whatever config they receive.",
    );
  }

  @callable()
  async selectLevel(raw: number): Promise<void> {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= LEVELS.length) return;
    if (isActive(this.state.rollout)) return this.system("Finish or roll back the current rollout first.", "warn");
    this.state.levelIndex = index;
    this.state.rollout = null;
    this.state.dcs = freshFleet();
    this.save();
    this.push(this.snapshot());
    await this.system(`Level ${index + 1}: ${this.level.title}. New ticket: ${this.level.ticket.id}.`);
    await this.withCopilot(() => copilot.preflightReview(this.env, this.level, this.state.memory.join("\n")));
  }

  @callable()
  async reset(): Promise<void> {
    if (isActive(this.state.rollout)) await this.stopWorkflow(this.state.rollout.id);
    await this.stopTicker();
    this.setState(freshState());
    this.messages = [];
    this.copilotSource = null;
    this.sql`DELETE FROM messages`;
    this.push({ type: "messages", messages: [] });
    this.push(this.snapshot());
    await this.welcome();
  }

  @callable()
  async deploy(): Promise<void> {
    if (isActive(this.state.rollout)) return this.system("A rollout is already in progress.", "warn");
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
      startedAt: now,
      lastTick: now,
      blast: 0,
    };
    const previous = this.state.rollout;
    this.state.dcs = freshFleet();
    this.state.rollout = rollout;
    this.save();

    try {
      await this.runWorkflow<RolloutParams>(
        "ROLLOUT_WORKFLOW",
        {
          rolloutId: rollout.id,
          stageCount: rollout.stages.length,
          bakeSec: plan.bakeSec,
          // After the final stage, watch the whole fleet for a while before declaring success.
          watchSec: Math.max(plan.bakeSec, 20),
        },
        { id: rollout.id, metadata: { level: this.level.id, strategy: plan.strategy } },
      );
    } catch (err) {
      // Don't leave a rollout "running" with nothing driving it.
      console.error("Failed to start the rollout workflow:", err);
      this.state.rollout = previous;
      this.save();
      this.push(this.snapshot());
      return this.system("The rollout couldn't start. Nothing was changed; try deploying again.", "bad");
    }
    const ticker = await this.scheduleEvery(TICK_SEC, "simulationTick");
    this.state.tickScheduleId = ticker.id;
    this.save();

    const stageText = rollout.stages.map((codes, i) => `${i + 1}) ${codes.length === 1 ? codes[0] : `${codes.length} DCs`} → ${trafficShare(rollout.stages.slice(0, i + 1).flat())}%`).join("  ");
    await this.system(`Rollout started (${plan.strategy}, bake ${plan.bakeSec}s). Stages: ${stageText}`);
    this.push(this.snapshot());
  }

  @callable()
  async proceed(): Promise<void> {
    const { rollout } = this.state;
    if (!rollout || rollout.status !== "awaiting-decision") {
      return this.system("Nothing to proceed with: the rollout isn't waiting for a decision.", "warn");
    }
    rollout.status = "running";
    this.save();
    this.push(this.snapshot());
    try {
      await this.sendWorkflowEvent("ROLLOUT_WORKFLOW", rollout.id, {
        type: decisionEvent(rollout.stageIndex),
        payload: { action: "proceed" },
      });
    } catch (err) {
      console.error("Failed to send the proceed decision:", err);
      if (rollout === this.state.rollout && rollout.status === "running") rollout.status = "awaiting-decision";
      this.save();
      this.push(this.snapshot());
      await this.system("Couldn't reach the rollout to proceed. Try again.", "warn");
    }
  }

  @callable()
  async rollbackNow(): Promise<void> {
    const { rollout } = this.state;
    if (!isActive(rollout)) return this.system("There's no active rollout to roll back.", "warn");
    await this.rollback(rollout.id, "player", "You rolled it back.");
    await this.stopWorkflow(rollout.id);
  }

  private async stopWorkflow(id: string): Promise<void> {
    try {
      await this.terminateWorkflow(id);
    } catch {
      // Already finished. Every workflow step also checks the rollout id, so a stale instance can't act.
    }
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
    this.save();
    this.push(this.snapshot());
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
    this.save();
    this.push(this.snapshot());
    const cumulative = trafficShare(rollout.stages.slice(0, stageIndex + 1).flat());
    await this.system(
      `Stage ${stageIndex + 1}/${rollout.stages.length}: config applied to ${codes.join(", ")}. ${cumulative}% of traffic now targeted.` +
        (validate ? " Fail-stale validation REJECTED it: those datacenters kept the last known-good config." : ""),
      validate ? "good" : "info",
    );
    return true;
  }

  async checkHealth(
    rolloutId: string,
    stageIndex: number,
  ): Promise<{ gateTripped: boolean; gateReason: string; report: copilot.StageReport } | null> {
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
    const baseline = Object.values(this.noise).reduce((a, b) => a + b, 0) / FLEET.length;
    this.save();
    if (offenders.length === 0) {
      const worst = rows.reduce((a, b) => (b.errorPct > a.errorPct ? b : a));
      await this.system(
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

  async copilotStageReview(rolloutId: string, report: copilot.StageReport): Promise<void> {
    if (!this.activeRollout(rolloutId)) return;
    await this.withCopilot(() => copilot.stageReview(this.env, this.level, report));
  }

  async awaitDecision(rolloutId: string, stageIndex: number): Promise<void> {
    const rollout = this.activeRollout(rolloutId);
    if (!rollout) return;
    rollout.status = "awaiting-decision";
    this.save();
    this.push(this.snapshot());
    const final = stageIndex === rollout.stages.length - 1;
    await this.system(
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
    await this.system(
      cause === "gate" ? `Automatic rollback. Health gate tripped: ${detail}.` : `Rolled back. ${detail}`,
      "warn",
    );
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
    await this.system(rollout.endReason, allRejected ? "good" : "info");
    await this.finish(!allRejected);
  }

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

    const { plan } = rollout;
    const summary =
      `${level.title}: ${plan.strategy} rollout, canary ${plan.canary}, bake ${plan.bakeSec}s, fail-stale ${rollout.failStale ? "on" : "off"}. ` +
      `Ended at stage ${rollout.stageIndex + 1}/${rollout.stages.length}: ${rollout.endReason} ` +
      `The change was ${isBad(level) ? "bad" : "good"}. Blast radius ${outcome.blast.toFixed(1)} %·s, grade ${outcome.grade}.`;
    this.state.memory.push(summary);
    if (this.state.memory.length > MAX_MEMORY) this.state.memory.shift();
    this.save();
    await this.stopTicker();
    this.push(this.snapshot());

    await this.post({
      role: "system",
      tone: outcome.passed ? "good" : "bad",
      text: `${outcome.passed ? "Level passed" : "Level failed"}. Grade ${outcome.grade}, blast radius ${outcome.blast.toFixed(1)} %·s. ${outcome.note} The change was ${isBad(level) ? "bad" : "good"}.`,
    });
    await this.withCopilot(() => copilot.debrief(this.env, level, summary));
  }
}
