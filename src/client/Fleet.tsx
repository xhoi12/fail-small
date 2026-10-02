// The fleet: every datacenter, its share of traffic, which config it runs and
// its live error rate. Tiles change colour as errors climb.

import type { GameView } from "../shared";
import { REGIONS, isActive } from "./ui";

export function Fleet({ view }: { view: GameView }) {
  const live = isActive(view.rollout);
  return (
    <article className="card fleet-card" aria-label="Fleet">
      <header className="card-head">
        <span className="eyebrow">Fleet{live ? " · live" : ""}</span>
        <span className="legend">
          <i className="dot old" /> Old config
          <i className="dot new" /> New config
          <i className="dot warn" /> Elevated
          <i className="dot bad" /> Failing
          <i className="dot rejected" /> Kept last known-good
        </span>
      </header>
      <div className="fleet">
        {REGIONS.map(([region, label]) => (
          <div key={region} className="region">
            <div className="region-name">{label}</div>
            <div className="region-dcs">
              {view.fleet
                .filter((dc) => dc.region === region)
                .map((dc) => {
                  const cls = dc.rejected ? "rejected" : dc.errorPct > 10 ? "bad" : dc.errorPct > 1 ? "warn" : dc.onNewConfig ? "new" : "";
                  return (
                    <div key={dc.code} className={`dc ${cls}`} title={`${dc.city}: ${dc.traffic}% of global traffic`}>
                      <b>
                        {dc.code}
                        <small>{dc.traffic}%</small>
                      </b>
                      <span className="err">{dc.errorPct.toFixed(1)}% err</span>
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
