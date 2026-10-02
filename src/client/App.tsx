// The game UI, in three zones: navigation (NavBar), the game itself (whose
// content follows the phase: plan → deploy → decide → debrief), and the
// co-pilot chat. One WebSocket to the player's GameSession agent (useAgent) carries:
//   - the game view and rollout log, as custom "game:*" frames (handled below);
//   - the co-pilot chat, through useAgentChat (see Chat.tsx);
//   - player actions, as calls to the agent's @callable() methods (agent.stub.*).

import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import type { GameSession } from "../game";
import type { GameEvent, GameView, ServerFrame } from "../shared";
import { Chat } from "./Chat";
import { ChangeCard } from "./Change";
import { Debrief } from "./Debrief";
import { Deployment } from "./Deployment";
import { Fleet } from "./Fleet";
import { HelpDialog } from "./HelpDialog";
import { Mission } from "./Mission";
import { NavBar } from "./NavBar";
import { PlanCard } from "./Plan";
import { phaseOf } from "./ui";

/** A random id per browser, so each player gets their own agent instance. */
function playerId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem("fail-small-player");
  } catch {}
  if (!id) {
    id = crypto.randomUUID();
    try {
      localStorage.setItem("fail-small-player", id);
    } catch {}
  }
  return id;
}

const PLAYER_ID = playerId();

/** Typed proxy for the agent's @callable() methods. */
export type GameStub = ReturnType<typeof useAgent<GameSession, unknown>>["stub"];

export function App() {
  const [view, setView] = useState<GameView | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // "Try again" after a finished rollout shows the plan again, until the next deploy.
  const [replanning, setReplanning] = useState(false);

  const onMessage = useCallback((message: MessageEvent) => {
    // The same socket also carries the SDK's own frames (chat, RPC, state); only handle ours.
    if (typeof message.data !== "string") return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(message.data);
    } catch {
      return;
    }
    if (frame.type === "game:view") setView(frame.view);
    else if (frame.type === "game:events") setEvents(frame.events);
    else if (frame.type === "game:event") setEvents((list) => [...list.slice(-199), frame.event]);
  }, []);

  const agent = useAgent<GameSession, unknown>({
    agent: "GameSession",
    name: PLAYER_ID,
    onMessage,
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
  });
  const game = agent.stub;

  // Leave "Try again" mode once a new rollout starts or the level changes.
  const rolloutId = view?.rollout?.id;
  const levelIndex = view?.levelIndex;
  useEffect(() => setReplanning(false), [rolloutId, levelIndex]);

  const phase = view ? phaseOf(view, replanning) : null;

  return (
    <div className="app">
      <NavBar view={view} game={game} onHelp={() => setHelpOpen(true)} />
      <div className="workspace">
        <main className="game" aria-label="Game">
          {!view || !phase ? (
            <div className="card muted">Connecting to your game…</div>
          ) : (
            <>
              <Mission view={view} phase={phase} />
              {phase === "debrief" && <Debrief view={view} game={game} onRetry={() => setReplanning(true)} />}
              {phase === "plan" ? (
                <>
                  <ChangeCard view={view} compact={false} />
                  <PlanCard view={view} game={game} />
                </>
              ) : (
                <>
                  <ChangeCard view={view} compact />
                  <Deployment view={view} events={events} game={game} />
                </>
              )}
              <Fleet view={view} />
            </>
          )}
        </main>
        <Chat agent={agent} mode={view?.copilotMode ?? null} />
      </div>
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      {!connected && <div className="offline-banner">Reconnecting…</div>}
    </div>
  );
}
