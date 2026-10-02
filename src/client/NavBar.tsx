// Navigation: the levels, the fail-stale setting, help and reset. Visually set
// apart (dark bar) so it never reads as part of the game itself.

import type { GameView } from "../shared";
import type { GameStub } from "./App";
import { isActive } from "./ui";

export function NavBar({ view, game, onHelp }: { view: GameView | null; game: GameStub; onHelp: () => void }) {
  const active = view ? isActive(view.rollout) : false;
  return (
    <header className="nav">
      <div className="nav-brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="nav-title">Fail Small</span>
      </div>

      <nav className="nav-levels" aria-label="Levels">
        <span className="nav-label">Levels</span>
        {view?.levels.map((level) => (
          <button
            key={level.id}
            type="button"
            className="nav-level"
            aria-current={level.index === view.levelIndex ? "page" : undefined}
            disabled={active && level.index !== view.levelIndex}
            title={active && level.index !== view.levelIndex ? "Finish or roll back the current rollout first" : level.title}
            onClick={() => game.selectLevel(level.index)}
          >
            <span className="nav-level-num">{level.index + 1}</span>
            <span className="nav-level-title">{level.title}</span>
            {level.result && <span className={`grade-chip grade-${level.result.grade}`}>{level.result.grade}</span>}
          </button>
        ))}
      </nav>

      <div className="nav-actions">
        <label
          className="switch"
          title={
            active
              ? "Can't change during a rollout"
              : "Datacenters validate new configs and keep serving the last known-good one if validation fails"
          }
        >
          <input
            type="checkbox"
            checked={view?.failStale ?? false}
            disabled={!view || active}
            onChange={(e) => game.setFailStale(e.target.checked)}
          />
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          <span>Fail stale</span>
        </label>
        <button type="button" className="nav-btn" onClick={onHelp}>
          How to play
        </button>
        <button
          type="button"
          className="nav-btn"
          onClick={() => confirm("Reset all progress, scores and chat history?") && game.reset()}
        >
          Reset
        </button>
      </div>
    </header>
  );
}
