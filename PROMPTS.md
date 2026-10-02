# Prompt history

Fail Small was built with an AI coding assistant (Claude Code). These are the prompts I gave it, in order, condensed
and cleaned up for readability, with a short note on what came back. The prompts the *app itself* sends to Llama 3.3 at
runtime are in [`src/copilot.ts`](src/copilot.ts) and summarized at the end.

How I prompted, in short: give the goal and the constraints up front, ask for options before code, make the
assistant check its plan against what I actually wanted, ask for evidence (tests, a scripted playthrough) instead
of "done", and feed playtest findings back as concrete changes.

---

## Session 1: from idea to playable game

### 1. The idea

> I want a small side project to properly learn Cloudflare's AI stack. Whatever we build should genuinely need:
>
> - an LLM (Llama 3.3 on Workers AI),
> - durable coordination (Workflows, Durable Objects / Agents),
> - chat as the way you interact with it,
> - memory or state that survives between sessions.
>
> Before writing any code, give me 4–5 ideas that would use all four for real rather than as decoration.
> For each: one line on what it is, which Cloudflare products it would use, and the riskiest part to build.

*Result:* five ideas, including an incident-response chat co-pilot, an SLO negotiator and a staged-rollout simulator,
each mapped to Workers AI, Agents, Workflows and Durable Objects.

### 2. Pushing past the obvious

> The incident co-pilot is the idea everyone reaches for, and "chatbot that summarizes logs" isn't much fun.
> I'd rather build something that teaches. Who would use a tool that lets engineers *practice* incidents safely, and
> what would it look like?

*Result:* reframed it as a training tool: a simulator where engineers rehearse failures they'd otherwise only meet in
production, with the LLM as a co-pilot inside the scenario rather than the product itself.

### 3. Grounding it in real practice

> Ground the scenarios in how config changes actually take down large networks. Read Cloudflare's "Code Orange: Fail
> Small" post and their public postmortems, and pull out the practices that would make good game mechanics.

*Result:* a shortlist of mechanics: health-mediated staged rollouts, canaries, bake time, automatic rollback gates,
fail-stale validation (keep the last known-good config), and the blast radius as the thing to minimize.

### 4. Checking feasibility

> Proposal: a Workflow runs the rollout across simulated datacenters in stages (1% → 10% → 50% → 100%), and the player
> decides at each stage. Is that buildable as a side project over a few evenings? Check that it really needs each of
> the four pieces, and list the risks before we commit.

*Result:* confirmed it was feasible because everything is simulated (datacenters are state, health is a function of
time and the hidden failure mode). Risks flagged: Workflows ↔ agent RPC, LLM output that's too long or confidently
wrong, and Workers AI needing an account during local dev.

### 5. The game design

> Make it a game. Constraints:
>
> - Clone, one command, play. It must work without a Cloudflare account.
> - The player is the release engineer; the score is the blast radius (% of requests failing × seconds).
> - 5 levels, each teaching one lesson, loosely based on public postmortems. At least one change must be *good*, so
>   rolling back everything isn't a strategy.
> - The co-pilot never sees the hidden failure mode. It reasons from the same diff and metrics as the player and is
>   allowed to be wrong. One level should make that the point.
> - Big-bang deploys can pass but can't get a top grade.
>
> Write the level list and scoring rules first. I'll review before you build.

*Result:* the five levels (Routine Change, The Feature File, Catastrophic Backtracking, Works On My Region, Below The
Gate), four error models (crash, slow burn, regional, subtle) and the grading table.

### 6. Architecture

> Build it on the Cloudflare Agents SDK. Rules:
>
> - One agent per player owns all state. The Workflow only coordinates: apply → bake → health check → gate or wait for
>   the player.
> - Every method the Workflow calls must be idempotent and check the rollout id, so retries and stale instances are
>   harmless.
> - The simulation and scoring are pure TypeScript with unit tests, with no Cloudflare APIs in them.
> - The LLM advises and never gates. Health gates are deterministic.
> - Plain HTML/CSS/JS frontend, no build step.

*Result:* `sim.ts` + tests, the `GameSession` agent, `RolloutWorkflow`, the co-pilot module and the UI.

### 7. Graceful degradation

> If Workers AI isn't available (not logged in, offline, quota), the game must not break. Fall back to scripted
> reviews per level, and make `npm start` detect login and pick local or remote mode on its own. Say clearly in the
> UI which co-pilot is answering.

*Result:* the offline co-pilot, the "Llama 3.3 / Offline (scripted)" pill, and `scripts/start.mjs`.

### 8. Prove it works

> Don't tell me it works; show me. Run the game locally and drive it with a scripted WebSocket player through every
> path: a good change shipped, a bad change caught by the gate, a player rollback mid-bake, fail-stale validation, and
> the regional trap with two different canaries. Fix whatever breaks and tell me what you fixed.

*Result:* all paths passed after fixing: error rates over 100%, stage messages arriving out of order, an invalid
WebSocket close code, and a CSS rule overriding `[hidden]`.

---

## Session 2: playtest feedback

### 9. Clearer UI

> I played through it. The rules are clear in the README but not in the game: a first-time player doesn't know what
> to do next, and the disabled Proceed / Roll back buttons just look broken. Put the how-to-play steps in the UI and
> add a "what to do now" prompt that follows the rollout state. Check it at desktop and phone widths.

*Result:* a How to play dialog (opens on first visit), a sticky step tracker with a one-line instruction for each
state (plan → watch → decide → debrief), numbered cards that light up when they're relevant, and a nudge on Proceed
when the game is waiting for you. Checked with screenshots at 1664px and 390px.

### 10. Use the Agents SDK properly

> Make sure we're using the Agents SDK and not a hand-rolled Durable Object: `Agent` state, `this.sql`,
> `scheduleEvery` for the tick, `@callable()` for player actions, `AgentWorkflow` + `runWorkflow` for rollouts,
> `routeAgentRequest` for routing. Keep the frontend build-free. Re-run the scripted playthroughs afterwards.

*Result:* `GameSession` now extends `Agent`; the rollout extends `AgentWorkflow`; the browser calls `@callable()`
methods over the SDK's WebSocket RPC. All scripted paths passed again.

### 11. Docs

> Update the README: say up front that this is a way for engineers to rehearse incident scenarios, explain why
> `wrangler login` is optional and what it unlocks, and show which SDK feature does what.

---

## Runtime prompts (what the app sends to Llama 3.3)

All in [`src/copilot.ts`](src/copilot.ts). The persona is shared; each call adds a task-specific instruction.

- **Persona.** At most 90 words, plain text. Cite the config keys, datacenters and numbers you were given. You
  advise, the player decides, and the gates act on their own. *You do not know whether the change is bad; never
  pretend to.* Prefer small, reversible steps.
- **Pre-flight review.** Point out risk in the diff, suggest a plan (strategy, canary, bake), end with
  `Risk: LOW | MEDIUM | HIGH`. Includes memory of the player's earlier rollouts.
- **Stage review.** First word `PROCEED` or `ROLLBACK`, then one or two sentences. Compare against the fleet
  baseline, not just the 10% gate.
- **Chat.** Persona plus the ticket, live game state and the last 10 turns.
- **Debrief.** Blameless, max 90 words: what happened, what went well, one thing to do differently. Only here is
  the hidden failure mode revealed to the model.

Hiding the failure mode from the model is on purpose: the co-pilot can only be as right as the data shown to it,
which is the lesson of the last level.
