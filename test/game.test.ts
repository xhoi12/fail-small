// Integration tests for the GameSession agent and the RolloutWorkflow, running in
// workerd. Workflow sleeps are disabled with introspectWorkflow, so a full rollout
// takes milliseconds, and Workers AI is replaced by a scripted model, so the
// co-pilot's tool calls and approvals can be tested without an account.

import { env, introspectWorkflow, runInDurableObject, SELF } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameSession } from "../src/game";
import type { ChatMessage } from "../src/shared";

// ---------------------------------------------------------------------------
// A scripted co-pilot model. Each test can set `nextReply` to decide what the
// model "says" for a prompt; by default it answers with a short sentence.
// ---------------------------------------------------------------------------

type Reply = { text: string } | { toolCall: { name: string; input: Record<string, unknown> } };
let nextReply: (prompt: string) => Reply = () => ({ text: "Looks fine to me." });

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const model = new MockLanguageModelV4({
  doStream: async ({ prompt }) => {
    const lastUser = [...prompt].reverse().find((m) => m.role === "user" || m.role === "tool");
    const promptText = lastUser?.role === "user" ? lastUser.content.map((p) => (p.type === "text" ? p.text : "")).join("") : "";
    // After a tool result, just wrap up.
    const reply: Reply = lastUser?.role === "tool" ? { text: "Done." } : nextReply(promptText);
    const chunks: LanguageModelV4StreamPart[] =
      "text" in reply
        ? [
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "t1" },
            { type: "text-delta" as const, id: "t1", delta: reply.text },
            { type: "text-end" as const, id: "t1" },
            { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
          ]
        : [
            { type: "stream-start" as const, warnings: [] },
            {
              type: "tool-call" as const,
              toolCallId: `call-${crypto.randomUUID()}`,
              toolName: reply.toolCall.name,
              input: JSON.stringify(reply.toolCall.input),
            },
            { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
          ];
    return { stream: simulateReadableStream({ chunks }) };
  },
});

vi.mock("workers-ai-provider", () => ({ createWorkersAI: () => () => model }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workflows: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeEach(async () => {
  nextReply = () => ({ text: "Looks fine to me." });
  workflows = await introspectWorkflow(env.ROLLOUT_WORKFLOW);
  await workflows.modifyAll(async (m) => {
    await m.disableSleeps();
  });
});

afterEach(async () => {
  await workflows.dispose();
});

async function newGame() {
  return getAgentByName<Env, GameSession>(env.GameSession, `test-${crypto.randomUUID()}`);
}

type Stub = Awaited<ReturnType<typeof newGame>>;

function inspect<T>(game: Stub, fn: (agent: GameSession) => T | Promise<T>): Promise<T> {
  return runInDurableObject(game, (agent: GameSession) => fn(agent));
}

/** Polls until `check` returns a truthy value. */
async function until<T>(check: () => Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Opens a WebSocket to the agent, the way the browser does. */
async function connect(game: Stub) {
  const name = await inspect(game, (agent) => agent.name);
  const res = await SELF.fetch(`http://localhost/agents/game-session/${name}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

/** Collects the next frame of a given type from the socket. */
function nextFrame(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const frame = typeof event.data === "string" ? JSON.parse(event.data) : null;
      if (frame?.type !== type) return;
      ws.removeEventListener("message", onMessage);
      resolve(frame);
    };
    ws.addEventListener("message", onMessage);
  });
}

const rollout = (game: Stub) => inspect(game, (agent) => agent.state.rollout);
const status = async (game: Stub) => (await rollout(game))?.status;

async function proceedUntilDone(game: Stub) {
  for (;;) {
    const s = await until(async () => {
      const current = await status(game);
      return current === "running" ? null : current;
    }, "a decision point or the end of the rollout");
    if (s !== "awaiting-decision") return s;
    await game.proceed();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rollouts", () => {
  it("ships a good change through every stage of a staged rollout", async () => {
    const game = await newGame();
    await game.updatePlan({ strategy: "staged", canary: "SCL", bakeSec: 5 });
    await game.deploy();

    expect(await proceedUntilDone(game)).toBe("completed");
    const done = await rollout(game);
    expect(done?.stageIndex).toBe(3);
    expect(done?.outcome).toMatchObject({ passed: true, grade: "S" });
    // Every datacenter ended up on the new config, and the schedule stopped ticking.
    const state = await inspect(game, (agent) => agent.state);
    expect(Object.values(state.dcs).every((dc) => dc.onNewConfig)).toBe(true);
    expect(state.tickScheduleId).toBeNull();
  });

  it("rolls a bad change back automatically when the health gate trips", async () => {
    const game = await newGame();
    await game.selectLevel(1); // The Feature File: the new config crashes the proxy.
    await game.deploy();

    expect(await until(async () => ((await status(game)) === "rolled-back" ? "yes" : null), "the gate")).toBe("yes");
    const done = await rollout(game);
    expect(done?.stageIndex).toBe(0); // caught at the canary
    expect(done?.endReason).toMatch(/Health gate tripped: SCL/);
    expect(done?.outcome?.passed).toBe(true);
  });

  it("keeps the last known-good config everywhere with fail-stale on", async () => {
    const game = await newGame();
    await game.selectLevel(1);
    await game.setFailStale(true);
    await game.updatePlan({ strategy: "big-bang" });
    await game.deploy();

    expect(await proceedUntilDone(game)).toBe("completed");
    const state = await inspect(game, (agent) => agent.state);
    expect(Object.values(state.dcs).every((dc) => dc.rejected && !dc.onNewConfig)).toBe(true);
    // Validation, not luck: big bang isn't capped at B here.
    expect(state.rollout?.outcome).toMatchObject({ passed: true, grade: "S" });
  });

  it("fails the level when a good change is rolled back", async () => {
    const game = await newGame();
    await game.deploy();
    await until(async () => ((await status(game)) === "awaiting-decision" ? "yes" : null), "stage 1");
    await game.rollbackNow();

    const done = await rollout(game);
    expect(done?.status).toBe("rolled-back");
    expect(done?.outcome).toMatchObject({ passed: false, grade: "F" });
    // A failed first attempt is still recorded as the level's best result.
    expect(await inspect(game, (agent) => agent.state.results.routine?.grade)).toBe("F");
  });

  it("ignores invalid input from the browser", async () => {
    const game = await newGame();
    await game.updatePlan({ strategy: "yolo" as never, canary: "XXX", bakeSec: 999 });
    await game.selectLevel(42);
    const state = await inspect(game, (agent) => agent.state);
    expect(state.plan).toEqual({ strategy: "staged", canary: "SCL", bakeSec: 15 });
    expect(state.levelIndex).toBe(0);
  });

  it("refuses state written directly by a client", async () => {
    const game = await newGame();
    const ws = await connect(game);
    const refused = nextFrame(ws, "cf_agent_state_error");
    const forged = { ...(await inspect(game, (agent) => agent.state)), results: { routine: { grade: "S", passed: true, blast: 0, strategy: "staged" } } };
    ws.send(JSON.stringify({ type: "cf_agent_state", state: forged }));

    expect(await refused).toMatchObject({ error: "State update rejected" });
    expect(await inspect(game, (agent) => agent.state.results)).toEqual({});
    ws.close();
  });
});

describe("co-pilot", () => {
  const chat = (game: Stub) => inspect(game, (agent) => agent.messages as ChatMessage[]);
  const pendingProposals = async (game: Stub) =>
    (await chat(game)).flatMap((m) => m.parts).filter((p) => "state" in p && p.state === "approval-requested").length;

  it("answers a typed command without the LLM, and reviews each stage", async () => {
    const game = await newGame();
    nextReply = (prompt) => ({ text: prompt.includes("[Game] Stage") ? "PROCEED. All within baseline." : "Risk: LOW." });
    await game.deploy();
    await until(async () => ((await status(game)) === "awaiting-decision" ? "yes" : null), "stage 1");

    const replies = (await chat(game)).filter((m) => m.role === "assistant").map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
    expect(replies).toContain("PROCEED. All within baseline.");
    // Server-initiated prompts are stored as hidden messages.
    expect((await chat(game)).filter((m) => m.metadata?.hidden).map((m) => m.metadata?.trigger)).toContain("stage-review");

    await inspect(game, (agent) =>
      agent.saveMessages((messages) => [...messages, { id: "u1", role: "user", parts: [{ type: "text", text: "rollback" }] }]),
    );
    expect(await status(game)).toBe("rolled-back");
  });

  it("proposes a rollback that only happens once the player approves it", async () => {
    const game = await newGame();
    await game.selectLevel(4); // Below The Gate: errors stay under the 10% gate.
    nextReply = (prompt) =>
      prompt.includes("[Game] Stage")
        ? { toolCall: { name: "rollBack", input: { reason: "SCL is well above baseline." } } }
        : { text: "Risk: MEDIUM." };
    await game.deploy();
    await until(async () => ((await status(game)) === "awaiting-decision" ? "yes" : null), "stage 1");

    // The proposal is waiting for approval; nothing has been rolled back yet.
    const proposal = await until(async () => {
      for (const m of await chat(game)) {
        for (const p of m.parts) if (p.type === "tool-rollBack" && p.state === "approval-requested") return p;
      }
      return null;
    }, "the rollBack proposal");
    expect(await status(game)).toBe("awaiting-decision");

    // Approve it, as the browser's Approve button does.
    const ws = await connect(game);
    ws.send(JSON.stringify({ type: "cf_agent_tool_approval", toolCallId: proposal.toolCallId, approved: true, autoContinue: true }));
    expect(await until(async () => ((await status(game)) === "rolled-back" ? "yes" : null), "the approved rollback")).toBe("yes");
    expect((await rollout(game))?.endReason).toBe("SCL is well above baseline.");
    ws.close();
  });

  it("withdraws a stale proposal when the player decides with the buttons", async () => {
    const game = await newGame();
    nextReply = (prompt) =>
      prompt.includes("[Game] Stage") ? { toolCall: { name: "rollBack", input: { reason: "Just in case." } } } : { text: "Risk: LOW." };
    await game.deploy();
    await until(async () => ((await status(game)) === "awaiting-decision" ? "yes" : null), "stage 1");
    await until(async () => (await pendingProposals(game)) || null, "the proposal");

    await game.proceed();

    const parts = (await chat(game)).flatMap((m) => m.parts).filter((p) => p.type === "tool-rollBack");
    expect(parts.at(-1)).toMatchObject({ state: "output-denied" });
    expect(await pendingProposals(game)).toBe(0);
  });
});
