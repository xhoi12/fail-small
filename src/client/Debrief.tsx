// The end of a level: the grade, what it means, and where to go next.

import type { GameView } from "../shared";
import type { GameStub } from "./App";

export function Debrief({ view, game, onRetry }: { view: GameView; game: GameStub; onRetry: () => void }) {
  const rollout = view.rollout!;
  const outcome = rollout.outcome;
  const { level } = view;
  const hasNext = view.levelIndex < view.levels.length - 1;
  if (!outcome) return null;
  // With fail-stale on, a "completed" rollout can mean every datacenter refused the config.
  const headline =
    rollout.status === "rolled-back"
      ? "Rolled back"
      : view.fleet.every((dc) => dc.rejected)
        ? "Rejected by validation everywhere"
        : "Shipped to 100%";
  return (
    <article className={`card debrief ${outcome.passed ? "pass" : "fail"}`} aria-label="Result">
      <div className={`debrief-grade grade-${outcome.grade}`}>{outcome.grade}</div>
      <div className="debrief-body">
        <div className="eyebrow">{outcome.passed ? "Level passed" : "Level failed"}</div>
        <h2>
          {headline} · blast radius {rollout.blast.toFixed(1)} %·s
        </h2>
        <p className="muted">{outcome.note}</p>
        {level.lesson && (
          <p className="debrief-lesson">
            <b>Lesson:</b> {level.lesson}
          </p>
        )}
        {level.inspiredBy && (
          <p className="muted small">
            Loosely based on{" "}
            <a href={level.inspiredBy.url} target="_blank" rel="noopener noreferrer">
              {level.inspiredBy.title}
            </a>
          </p>
        )}
        <div className="debrief-actions">
          {hasNext && (
            <button type="button" className="btn btn-primary btn-lg" onClick={() => game.selectLevel(view.levelIndex + 1)}>
              Next level →
            </button>
          )}
          <button type="button" className={`btn ${hasNext ? "btn-ghost" : "btn-primary btn-lg"}`} onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    </article>
  );
}
