// `npm start`: one command to play.
//
// Logged in to Cloudflare (`npx wrangler login`) → the co-pilot runs on Llama 3.3 (Workers AI).
// Not logged in, or `npm start -- --offline` → everything runs locally with a scripted co-pilot.
// If connecting to Workers AI fails at startup, it falls back to the offline co-pilot.
//
// Either way it starts `vite dev`, which runs the React app and, through the Cloudflare
// Vite plugin, the Worker, the agent and the Workflow in a local workerd.

import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const bin = (name) => {
  const path = fileURLToPath(new URL(`../node_modules/.bin/${name}${windows ? ".cmd" : ""}`, import.meta.url));
  // Node refuses to run .cmd files without a shell on Windows; quote the path in case it has spaces.
  return windows ? `"${path}"` : path;
};

function loggedIn() {
  if (process.env.CLOUDFLARE_API_TOKEN) return true;
  try {
    const out = execFileSync(bin("wrangler"), ["whoami"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: windows,
    });
    return !/not authenticated/i.test(out);
  } catch {
    return false;
  }
}

const SUBDOMAIN_HELP =
  "  If your Cloudflare account is new, it needs a free workers.dev subdomain first: in the dashboard,\n" +
  "  open Workers & Pages (https://dash.cloudflare.com/?to=/:account/workers-and-pages), find\n" +
  "  \"Your subdomain\" and set one up. Then run `npm start` again.\n";

function start(offline) {
  console.log(
    offline
      ? "\n  Fail Small: offline co-pilot (scripted replies).\n" +
          "  For the AI co-pilot, see \"Offline co-pilot vs AI co-pilot\" in the README.\n"
      : "\n  Fail Small: co-pilot powered by Llama 3.3 on Workers AI.\n",
  );
  const startedAt = Date.now();
  const child = spawn(bin("vite"), ["dev", "--open"], {
    stdio: "inherit",
    shell: windows,
    env: { ...process.env, FAIL_SMALL_OFFLINE: offline ? "1" : "" },
  });
  child.on("exit", (code) => {
    // Logged in, but the dev server died while connecting to Cloudflare (usually a new account
    // without a workers.dev subdomain). Don't leave the player with a stack trace: play offline.
    if (!offline && code && Date.now() - startedAt < 60_000) {
      console.log("\n  Couldn't connect to Workers AI, so starting with the offline co-pilot instead.\n" + SUBDOMAIN_HELP);
      return start(true);
    }
    process.exit(code ?? 0);
  });
}

start(process.argv.includes("--offline") || !loggedIn());
