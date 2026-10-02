import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

// `npm start` sets FAIL_SMALL_OFFLINE=1 when you're not logged in to Cloudflare: then
// nothing reaches out to Cloudflare (no remote bindings) and the co-pilot uses its
// scripted replies. Logged in, Workers AI runs remotely and everything else locally.
const offline = process.env.FAIL_SMALL_OFFLINE === "1";

export default defineConfig({
  plugins: [
    // TC39 decorator support for @callable() (Vite 8's transpiler doesn't do them yet).
    agents(),
    react(),
    // Runs the Worker, the agent and the Workflow in workerd next to the Vite dev server.
    cloudflare({
      remoteBindings: !offline,
      config: offline ? { vars: { COPILOT_MODE: "offline" } } : undefined,
    }),
  ],
});
