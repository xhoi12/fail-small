// The top of the game area: which level you're on, where you are in it
// (Plan → Deploy & watch → Decide → Debrief), and what to do next.

import type { GameView } from "../shared";
import { PHASES, type Phase } from "./ui";

function nextStep(view: GameView, phase: Phase): string {
  const { rollout } = view;
  switch (phase) {
    case "plan":
      return "Read the change and the co-pilot's review, choose how to roll it out, then press Deploy.";
    case "deploy":
      return rollout && rollout.stageIndex >= 0
        ? "The stage is baking. Watch the fleet for errors; the health gate rolls back on its own above 10%. You can roll back any time."
        : "Applying the config to the first datacenters…";
    case "decide":
      return "The stage passed the 10% health gate, but the gate only catches big failures. Compare against the ~0.3% baseline, then proceed or roll back.";
    case "debrief":
      return "Read the result and the co-pilot's debrief. Try again for a better grade, or move on.";
  }
}

export function Mission({ view, phase }: { view: GameView; phase: Phase }) {
  const current = PHASES.findIndex((p) => p.id === phase);
  return (
    <section className="mission" aria-label="Level progress">
      <div className="mission-head">
        <div>
          <div className="eyebrow">
            Level {view.levelIndex + 1} of {view.levels.length}
          </div>
          <h1 className="mission-title">{view.level.title}</h1>
        </div>
        <ol className="stepper" aria-label="Steps">
          {PHASES.map((p, i) => (
            <li key={p.id} className={i < current ? "done" : i === current ? "current" : ""} aria-current={i === current ? "step" : undefined}>
              <span className="stepper-dot">{i < current ? "✓" : i + 1}</span>
              <span className="stepper-label">{p.label}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className={`mission-next phase-${phase}`}>
        <b>Next:</b> {nextStep(view, phase)}
      </p>
    </section>
  );
}
