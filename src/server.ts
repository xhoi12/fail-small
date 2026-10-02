// Worker entry point. In production, Workers Static Assets serve the built React
// app (dist/client) and this handler only sees /agents/* and /api/*; in
// development the Cloudflare Vite plugin does the same.

import { routeAgentRequest } from "agents";

export { GameSession } from "./game";
export { RolloutWorkflow } from "./workflow";

// One agent instance per player: /agents/game-session/<player-id>[/...]
// (the chat client also fetches /agents/game-session/<player-id>/get-messages).
const AGENT_PATH = /^\/agents\/game-session\/[A-Za-z0-9-]{8,64}(\/|$)/;

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
