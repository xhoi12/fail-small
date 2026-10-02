// RolloutWorkflow: a health-mediated, staged config rollout, one durable step at a time.
//
//   for each stage:  apply config → bake (sleep) → health check
//                    → gate tripped? automatic rollback
//                    → co-pilot review → wait for the player's decision
//   the last stage bakes longer (the "final watch"); proceeding after it completes the rollout.
//
// It extends the Agents SDK's AgentWorkflow, so `this.agent` is a typed stub back to the
// GameSession agent that started it with runWorkflow(). All state lives in that agent; the
// workflow only coordinates. Steps are retried on failure and the agent's methods are
// idempotent, so a crashed or retried step never double-applies anything.

import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import { decisionEvent, type GameSession } from "./game";

export interface RolloutParams {
  rolloutId: string;
  stageCount: number;
  bakeSec: number;
  watchSec: number;
}

export class RolloutWorkflow extends AgentWorkflow<GameSession, RolloutParams> {
  async run(event: AgentWorkflowEvent<RolloutParams>, step: AgentWorkflowStep) {
    const { rolloutId, stageCount, bakeSec, watchSec } = event.payload;
    const game = this.agent;

    for (let i = 0; i < stageCount; i++) {
      const n = i + 1;
      const last = i === stageCount - 1;

      const applied = await step.do(`stage ${n}: apply config`, () => game.applyStage(rolloutId, i));
      if (!applied) return "aborted";

      await step.sleep(`stage ${n}: bake`, `${last ? watchSec : bakeSec} seconds`);

      const health = await step.do(`stage ${n}: health check`, () => game.checkHealth(rolloutId, i));
      if (!health) return "aborted";

      if (health.gateTripped) {
        await step.do(`stage ${n}: automatic rollback`, () => game.rollback(rolloutId, "gate", health.gateReason));
        return "rolled-back-by-gate";
      }

      await step.do(`stage ${n}: co-pilot review`, () => game.copilotStageReview(rolloutId, health.report));

      // The player decides after every stage, including the last: health gates only catch the obvious failures.
      await step.do(`stage ${n}: request decision`, () => game.awaitDecision(rolloutId, i));
      try {
        await step.waitForEvent(`stage ${n}: decision`, { type: decisionEvent(i), timeout: "10 minutes" });
      } catch {
        await step.do(`stage ${n}: decision timeout`, () =>
          game.rollback(rolloutId, "timeout", "No decision within 10 minutes, so the change was rolled back."),
        );
        return "timed-out";
      }
      // A rollback from the player terminates this instance, so reaching here means "proceed".
    }

    await step.do("complete rollout", () => game.completeRollout(rolloutId));
    return "completed";
  }
}
