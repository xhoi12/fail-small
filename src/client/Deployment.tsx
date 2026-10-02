// The deployment: a pipeline of stages with live progress, the blast radius,
// the decision you owe after each stage, and the activity log.

import { useEffect, useRef } from "react";
import type { GameEvent, GameView } from "../shared";
import type { GameStub } from "./App";
import { GRADE_BANDS, fmtCodes, gradeFor, isActive, useNow, type Rollout } from "./ui";

type NodeState = { cls: string; label: string; progress?: number };

/** What one stage node shows, given where the rollout is. */
function stageState(rollout: Rollout, i: number, now: number): NodeState {
  const { stageIndex, status, phase } = rollout;
  if (status === "completed") return { cls: "done", label: "Done" };
  if (status === "rolled-back") return i <= stageIndex ? { cls: "reverted", label: "Rolled back" } : { cls: "skipped", label: "Not reached" };
  const current = Math.max(stageIndex, 0);
  if (i < current) return { cls: "done", label: "Healthy" };
  if (i > current) return { cls: "pending", label: "Waiting" };
  switch (phase) {
    case "baking": {
      const left = Math.max(0, ((rollout.bakeEndsAt ?? now) - now) / 1000);
      const total = rollout.bakeTotalSec ?? 1;
      return { cls: "active", label: `Baking · ${Math.ceil(left)}s left`, progress: 1 - left / total };
    }
    case "checking":
      return { cls: "active", label: "Health check…" };
    case "reviewing":
      return { cls: "active", label: "Co-pilot reviewing…" };
    case "deciding":
      return { cls: "decide", label: "Your call" };
    default:
      return { cls: "active", label: "Applying…" };
  }
}

export function Deployment({ view, events, game }: { view: GameView; events: GameEvent[]; game: GameStub }) {
  const rollout = view.rollout!;
  const active = isActive(rollout);
  const now = useNow(active && rollout.phase === "baking");
  const { plan } = rollout;
  let cumulative = 0;

  return (
    <article className="card deployment" aria-label="Deployment">
      <header className="card-head">
        <span className="eyebrow">Deployment</span>
        <span className="muted">
          {plan.strategy} · canary {plan.canary} · bake {plan.bakeSec}s
        </span>
      </header>

      <BlastMeter blast={rollout.blast} live={active} />

      <ol className="pipeline">
        {rollout.stages.map((stage, i) => {
          cumulative += stage.traffic;
          const state = stageState(rollout, i, now);
          return (
            <li key={i} className={`pipe-stage ${state.cls}`}>
              <div className="pipe-top">
                <b>{i === 0 && plan.strategy === "staged" ? "Canary" : `Stage ${i + 1}`}</b>
                <span className="pipe-pct">{cumulative}%</span>
              </div>
              <div className="pipe-codes">{fmtCodes(stage.codes)}</div>
              <div className="pipe-state">{state.label}</div>
              {state.progress !== undefined && (
                <div className="pipe-bar">
                  <span style={{ width: `${Math.min(100, state.progress * 100)}%` }} />
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <Decision rollout={rollout} game={game} />
      <ActivityLog events={events} />
    </article>
  );
}

/** Blast radius so far, against the grade bands. */
function BlastMeter({ blast, live }: { blast: number; live: boolean }) {
  const grade = gradeFor(blast);
  return (
    <div className="blast">
      <div>
        <div className="blast-value">
          {blast.toFixed(1)}
          <small> %·s</small>
        </div>
        <div className="muted blast-label">Blast radius: % of requests failing × seconds</div>
      </div>
      {/* While it runs, show which grade the blast radius is heading for; after, the debrief has the real grade. */}
      {live && (
        <ol className="bands" aria-label={`Currently in grade ${grade} territory`}>
          {GRADE_BANDS.map((band, i) => (
            <li key={band.grade} className={band.grade === grade ? `on grade-${band.grade}` : ""}>
              <b>{band.grade}</b>
              <small>{band.max === Infinity ? `> ${GRADE_BANDS[i - 1].max}` : `≤ ${band.max}`}</small>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The call the player owes after each stage, or a way out while it runs. */
function Decision({ rollout, game }: { rollout: Rollout; game: GameStub }) {
  if (rollout.status === "awaiting-decision") {
    const last = rollout.stageIndex === rollout.stages.length - 1;
    const next = rollout.stages.slice(0, rollout.stageIndex + 2).reduce((sum, s) => sum + s.traffic, 0);
    return (
      <div className="decision decide">
        <div>
          <b>
            {last
              ? "The whole fleet has run the new config through the final watch."
              : `Stage ${rollout.stageIndex + 1} passed the 10% health gate.`}
          </b>
          <p>
            {last
              ? "Mark it as shipped, or roll back if anything looks off."
              : `Proceeding takes the change to ${next}% of traffic. Check the fleet against the baseline first.`}
          </p>
        </div>
        <div className="decision-buttons">
          <button type="button" className="btn btn-danger" onClick={() => game.rollbackNow()}>
            Roll back
          </button>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => game.proceed()}>
            {last ? "Ship it ✓" : `Proceed to ${next}% →`}
          </button>
        </div>
      </div>
    );
  }
  if (isActive(rollout)) {
    return (
      <div className="decision running">
        <p>The health gate is watching. You'll be asked to decide when the stage is done.</p>
        <button type="button" className="btn btn-danger-ghost" onClick={() => game.rollbackNow()}>
          Roll back now
        </button>
      </div>
    );
  }
  return null;
}

/** What the game did, newest at the bottom. */
function ActivityLog({ events }: { events: GameEvent[] }) {
  const box = useRef<HTMLOListElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [events]);
  if (!events.length) return null;
  return (
    <details className="log" open>
      <summary>Activity log</summary>
      <ol ref={box}>
        {events.map((event) => (
          <li key={event.id} className={event.tone}>
            <time>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
            <span>{event.text}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
