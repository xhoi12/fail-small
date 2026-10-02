// `npm start`: one command to play.
// Logged in to Cloudflare → the co-pilot runs on Llama 3.3 (Workers AI).
// Not logged in → everything runs locally with a scripted co-pilot.

import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const bin = fileURLToPath(new URL(`../node_modules/.bin/wrangler${windows ? ".cmd" : ""}`, import.meta.url));
// Node refuses to run .cmd files without a shell on Windows; quote the path in case it has spaces.
const run = windows ? `"${bin}"` : bin;

function loggedIn() {
  if (process.env.CLOUDFLARE_API_TOKEN) return true;
  try {
    const out = execFileSync(run, ["whoami"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: windows });
    return !/not authenticated/i.test(out);
  } catch {
    return false;
  }
}

const online = loggedIn();
const args = online ? ["dev"] : ["dev", "--local", "--var", "COPILOT_MODE:offline"];

console.log(
  online
    ? "\n  Fail Small: co-pilot powered by Llama 3.3 on Workers AI.\n"
    : "\n  Fail Small: offline mode (scripted co-pilot).\n" +
        "  For the real AI co-pilot, run `npx wrangler login` and then `npm start` again.\n",
);
console.log("  Open http://localhost:8787 once it's ready (or press b).\n");

const child = spawn(run, args, { stdio: "inherit", shell: windows });
child.on("exit", (code) => process.exit(code ?? 0));
