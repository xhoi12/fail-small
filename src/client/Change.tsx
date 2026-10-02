// The change ticket and its config diff. Full size while planning; a one-line
// summary (expandable) once the rollout is underway.

import type { GameView } from "../shared";

const fmt = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v));

function changedKeys(view: GameView): string[] {
  const { before, after } = view.level.config;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

function Diff({ view }: { view: GameView }) {
  const { before, after } = view.level.config;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return (
    <div className="diff" role="table" aria-label="Config diff">
      {keys.map((key) => {
        const changed = JSON.stringify(before[key]) !== JSON.stringify(after[key]);
        return (
          <div key={key} className={`diff-row${changed ? " changed" : ""}`} role="row">
            <div className="diff-key" role="cell">
              {key}
            </div>
            <div className="diff-vals" role="cell">
              {changed ? (
                <>
                  {before[key] !== undefined && <span className="diff-del">{fmt(before[key])}</span>}
                  {after[key] !== undefined && <span className="diff-add">{fmt(after[key])}</span>}
                </>
              ) : (
                <span>{fmt(before[key])}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ChangeCard({ view, compact }: { view: GameView; compact: boolean }) {
  const { ticket, config } = view.level;
  if (compact) {
    return (
      <details className="card change-compact">
        <summary>
          <span className="eyebrow">The change</span>
          <span className="change-compact-title">
            {ticket.id} · {ticket.summary}
          </span>
          <span className="change-compact-keys">
            {changedKeys(view).join(", ")} changed in <code>{config.name}</code>
          </span>
        </summary>
        <Diff view={view} />
      </details>
    );
  }
  return (
    <article className="card">
      <header className="card-head">
        <span className="eyebrow">The change · {ticket.id}</span>
        <span className="muted">by {ticket.author}</span>
      </header>
      <h2>{ticket.summary}</h2>
      <p className="muted">{ticket.description}</p>
      <div className="file">
        <code>{config.name}</code>
        <span className="muted">→ read by: {config.consumer}</span>
      </div>
      <Diff view={view} />
    </article>
  );
}
