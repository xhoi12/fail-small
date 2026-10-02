import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime (workerd) with the real bindings from
// wrangler.jsonc: the GameSession agent, its SQLite storage and the Workflow.
// Nothing reaches Cloudflare: the tests mock the Workers AI model (see test/game.test.ts).
export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
    }),
  ],
});
