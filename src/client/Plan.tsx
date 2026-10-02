// Choosing how the change reaches the fleet: strategy, canary, bake time.
// The preview shows exactly which datacenters each stage will hit.

import type { GameView } from "../shared";
import type { GameStub } from "./App";
import { REGIONS, fmtCodes } from "./ui";

const STRATEGIES = [
  { value: "staged", label: "Staged", detail: "Canary → 10% → 50% → 100%", hint: "Slowest, safest" },
  { value: "fast", label: "Fast", detail: "10% → 100%", hint: "Two steps" },
  { value: "big-bang", label: "Big bang", detail: "100% at once", hint: "Grade capped at B" },
] as const;

export function PlanCard({ view, game }: { view: GameView; game: GameStub }) {
  const { plan, planStages } = view;
  let cumulative = 0;
  return (
    <article className="card plan">
      <header className="card-head">
        <span className="eyebrow">Your rollout plan</span>
        <span className="muted">How the change reaches the fleet</span>
      </header>

      <fieldset className="strategies">
        <legend>Strategy</legend>
        {STRATEGIES.map((s) => (
          <label key={s.value} className="strategy">
            <input
              type="radio"
              name="strategy"
              value={s.value}
              checked={plan.strategy === s.value}
              onChange={() => game.updatePlan({ strategy: s.value })}
            />
            <span>
              <b>{s.label}</b>
              <small>{s.detail}</small>
              <small className="strategy-hint">{s.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="plan-fields">
        <label className="field">
          <span>Canary datacenter</span>
          <select
            value={plan.canary}
            disabled={plan.strategy === "big-bang"}
            onChange={(e) => game.updatePlan({ canary: e.target.value })}
          >
            {REGIONS.map(([region, label]) => (
              <optgroup key={region} label={label}>
                {view.fleet
                  .filter((dc) => dc.region === region)
                  .map((dc) => (
                    <option key={dc.code} value={dc.code}>
                      {dc.code} · {dc.city} ({dc.traffic}% of traffic)
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <small>Gets the change first. Pick one whose traffic looks like the change's risk.</small>
        </label>
        <label className="field">
          <span>Bake time per stage</span>
          <select value={plan.bakeSec} onChange={(e) => game.updatePlan({ bakeSec: Number(e.target.value) })}>
            {view.bakeOptions.map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
          <small>How long each stage runs before its health check. Some failures take time.</small>
        </label>
      </div>

      <div className="plan-preview" aria-label="Stages this plan will run">
        {planStages.map((stage, i) => {
          cumulative += stage.traffic;
          return (
            <div key={i} className="plan-stage">
              <b>{i === 0 && plan.strategy === "staged" ? "Canary" : `Stage ${i + 1}`}</b>
              <span>{cumulative}% of traffic</span>
              <small>{fmtCodes(stage.codes)}</small>
            </div>
          );
        })}
      </div>

      <div className="plan-actions">
        <button type="button" className="btn btn-primary btn-lg" onClick={() => game.deploy()}>
          Deploy change
        </button>
        <span className="muted">
          {view.failStale ? "Fail-stale validation is on." : "Fail-stale validation is off (toggle it in the top bar)."}
        </span>
      </div>
    </article>
  );
}
