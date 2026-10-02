// Worker entry point. Static assets (the game UI in /public) are served by
// Workers Static Assets before this handler runs; this only routes the API.

import { routeAgentRequest } from "agents";

export { GameSession } from "./game";
export { RolloutWorkflow } from "./workflow";

// One agent instance per player: /agents/game-session/<player-id>
const AGENT_PATH = /^\/agents\/game-session\/[A-Za-z0-9-]{8,64}$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/agents/")) {
      if (!AGENT_PATH.test(url.pathname)) return new Response("Missing or invalid player id", { status: 400 });
      return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, copilotMode: env.COPILOT_MODE });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
