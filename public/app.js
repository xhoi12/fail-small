// Fail Small: browser client. Everything lives in the player's GameSession agent
// (Cloudflare Agents SDK); this file renders the state it pushes and calls the
// agent's @callable() methods over the same WebSocket.

const $ = (id) => document.getElementById(id);
const REGIONS = [
  ["NA", "N. America"],
  ["EU", "Europe"],
  ["APAC", "Asia-Pac"],
  ["LATAM", "LatAm"],
  ["AF", "Africa"],
];
const STRATEGY_LABEL = { "big-bang": "Big bang", fast: "Fast", staged: "Staged" };

let socket = null;
let state = null;
let retry = 0;
const pending = new Map();

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function playerId() {
  let id = null;
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

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/agents/game-session/${encodeURIComponent(playerId())}`);
  socket.addEventListener("open", () => {
    retry = 0;
    $("offline-banner").hidden = true;
  });
  socket.addEventListener("message", (event) => handle(JSON.parse(event.data)));
  socket.addEventListener("close", () => {
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
    $("offline-banner").hidden = false;
    setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  });
}

/** Calls a @callable() method on the agent (Agents SDK WebSocket RPC). */
function call(method, ...args) {
  if (socket?.readyState !== WebSocket.OPEN) return Promise.resolve();
  const id = crypto.randomUUID();
  socket.send(JSON.stringify({ type: "rpc", id, method, args }));
  return new Promise((resolve) => pending.set(id, resolve));
}

function handle(msg) {
  switch (msg.type) {
    case "rpc": {
      const resolve = pending.get(msg.id);
      if (!resolve) break;
      pending.delete(msg.id);
      if (!msg.success) console.error(`RPC failed: ${msg.error}`);
      resolve(msg.success ? msg.result : undefined);
      break;
    }
    case "state":
      state = msg;
      render();
      break;
    case "messages":
      $("messages").replaceChildren(...msg.messages.map(renderMessage));
      scrollChat();
      break;
    case "message":
      $("messages").append(renderMessage(msg.message));
      scrollChat();
      if (msg.message.source) renderSource(msg.message.source);
      break;
    case "typing":
      $("typing").hidden = !msg.on;
      if (msg.on) scrollChat();
      break;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined));
  return node;
}

const isActive = (rollout) => rollout && (rollout.status === "running" || rollout.status === "awaiting-decision");

function render() {
  const { level, rollout } = state;
  const active = isActive(rollout);

  // Levels
  $("levels").replaceChildren(
    ...state.levels.map((l) =>
      el(
        "button",
        {
          class: "level-btn",
          type: "button",
          "aria-current": l.index === state.levelIndex ? "true" : "false",
          disabled: active && l.index !== state.levelIndex,
          title: l.title,
          onclick: () => call("selectLevel", l.index),
        },
        el("span", { class: "level-num" }, String(l.index + 1)),
        el("span", { class: "level-title" }, l.title),
        l.result ? el("span", { class: `grade grade-${l.result.grade}` }, l.result.grade) : null,
      ),
    ),
  );
  $("fail-stale").checked = state.failStale;
  $("fail-stale").disabled = active;

  // Ticket
  $("ticket-id").textContent = `${level.ticket.id} · Level ${state.levelIndex + 1}: ${level.title}`;
  $("ticket-author").textContent = level.ticket.author;
  $("ticket-summary").textContent = level.ticket.summary;
  $("ticket-description").textContent = level.ticket.description;
  $("config-name").textContent = level.config.name;
  $("config-consumer").textContent = `→ ${level.config.consumer}`;
  renderDiff(level.config.before, level.config.after);

  // Plan
  for (const input of document.querySelectorAll('input[name="strategy"]')) {
    input.checked = input.value === state.plan.strategy;
    input.disabled = active;
  }
  const canary = $("canary");
  if (!canary.options.length) {
    for (const [region, label] of REGIONS) {
      const group = el("optgroup", { label });
      for (const dc of state.fleet.filter((d) => d.region === region)) {
        group.append(el("option", { value: dc.code }, `${dc.code} · ${dc.city} (${dc.traffic}%)`));
      }
      canary.append(group);
    }
  }
  canary.value = state.plan.canary;
  canary.disabled = active || state.plan.strategy === "big-bang";
  const bake = $("bake");
  if (!bake.options.length) for (const s of state.bakeOptions) bake.append(el("option", { value: s }, `${s} seconds`));
  bake.value = String(state.plan.bakeSec);
  bake.disabled = active;
  $("plan-preview").replaceChildren(...renderStages(state.planStages, -1, false));
  $("deploy").disabled = active;
  $("deploy").textContent = rollout && !active ? "Deploy again" : "Deploy change";

  // Rollout
  const status = $("rollout-status");
  const statusInfo = !rollout
    ? ["Not started", ""]
    : {
        running: [`Running · stage ${rollout.stageIndex + 1}/${rollout.stages.length}`, "info"],
        "awaiting-decision": [`Waiting for you · stage ${rollout.stageIndex + 1}/${rollout.stages.length}`, "warn"],
        completed: ["Completed", "ok"],
        "rolled-back": ["Rolled back", "bad"],
      }[rollout.status];
  status.textContent = statusInfo[0];
  status.className = `pill ${statusInfo[1]}`;
  $("blast").textContent = (rollout?.blast ?? 0).toFixed(1);
  $("proceed").disabled = rollout?.status !== "awaiting-decision";
  $("proceed").textContent = rollout && rollout.stageIndex === rollout.stages.length - 1 ? "Ship it" : "Proceed";
  $("rollback").disabled = !active;
  $("rollout-stages").replaceChildren(...(rollout ? renderStages(rollout.stages, rollout.stageIndex, active) : []));
  renderResult();

  renderFleet();
  renderCoach();
  if (state.copilotSource) renderSource(state.copilotSource);
}

/** The "what do I do now?" banner and step tracker, driven by the rollout state. */
function renderCoach() {
  const { rollout } = state;
  const result = rollout?.outcome;
  const stage = rollout ? `Stage ${rollout.stageIndex + 1} of ${rollout.stages.length}` : "";
  let step, title, text, focus;

  if (!rollout) {
    step = 0;
    title = "Read the change, then plan the rollout";
    text =
      "Read the ticket and the diff below, and the co-pilot's review on the right. Then pick a strategy, a canary " +
      "datacenter and a bake time, and press Deploy change.";
    focus = ["ticket-card", "plan-card"];
  } else if (rollout.status === "running") {
    step = 1;
    title = rollout.stageIndex < 0 ? "Deploying…" : `${stage} is baking`;
    text =
      "Watch the fleet: blue tiles run the new config, amber and red tiles are seeing errors. If any datacenter goes " +
      "over 10% errors, the health gate rolls back on its own. You can roll back early at any time.";
    focus = ["rollout-card", "fleet-card"];
  } else if (rollout.status === "awaiting-decision") {
    step = 2;
    const last = rollout.stageIndex === rollout.stages.length - 1;
    title = last ? "Your call: ship it, or roll back" : `Your call: proceed to stage ${rollout.stageIndex + 2}, or roll back`;
    text =
      `${stage} passed the 10% health gate, but the gate only catches big failures. Compare each datacenter on the ` +
      "new config with the ~0.3% baseline, and read the co-pilot's take, before you decide.";
    focus = ["rollout-card", "fleet-card"];
  } else {
    step = 3;
    title = !result ? "Rollout finished" : result.passed ? `Level passed · grade ${result.grade}` : `Level failed · grade ${result.grade}`;
    text =
      (rollout.endReason ? `${rollout.endReason} ` : "") +
      "Read the lesson in the Rollout card and the co-pilot's debrief. Deploy again to improve your grade, or move on to the next level.";
    focus = ["rollout-card"];
  }

  [...$("steps").children].forEach((li, i) => (li.className = i < step ? "done" : i === step ? "current" : ""));
  $("coach").dataset.step = String(step);
  $("coach-title").textContent = title;
  $("coach-text").textContent = text;
  for (const id of ["ticket-card", "plan-card", "rollout-card", "fleet-card"]) $(id).classList.toggle("focus", focus.includes(id));
  $("proceed").classList.toggle("attention", rollout?.status === "awaiting-decision");
}

function renderDiff(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const fmt = (v) => (Array.isArray(v) ? v.join(", ") : String(v));
  $("diff").replaceChildren(
    ...keys.map((key) => {
      const a = before[key];
      const b = after[key];
      const changed = JSON.stringify(a) !== JSON.stringify(b);
      return el(
        "div",
        { class: `diff-row${changed ? " changed" : ""}`, role: "row" },
        el("div", { class: "diff-key", role: "cell" }, key),
        el(
          "div",
          { class: "diff-vals", role: "cell" },
          changed
            ? [a !== undefined ? el("span", { class: "diff-del" }, fmt(a)) : null, b !== undefined ? el("span", { class: "diff-add" }, fmt(b)) : null]
            : el("span", {}, fmt(a)),
        ),
      );
    }),
  );
}

function renderStages(stages, currentIndex, active) {
  let cumulative = 0;
  return stages.map((stage, i) => {
    cumulative += stage.traffic;
    const cls = i < currentIndex || (i === currentIndex && !active) ? "done" : i === currentIndex ? "current" : "";
    const who = stage.codes.length <= 3 ? stage.codes.join(", ") : `${stage.codes.slice(0, 3).join(", ")} +${stage.codes.length - 3}`;
    return el("div", { class: `stage ${cls}` }, el("b", {}, `Stage ${i + 1} → ${cumulative}%`), el("span", {}, who));
  });
}

function renderResult() {
  const box = $("result");
  const { rollout, level } = state;
  const result = rollout?.outcome;
  if (!rollout || isActive(rollout) || !result) {
    box.hidden = true;
    return;
  }
  const last = rollout.status === "completed" ? "Reached 100%" : "Rolled back";
  const isLastLevel = state.levelIndex === state.levels.length - 1;
  box.hidden = false;
  box.className = `result ${result.passed ? "pass" : "fail"}`;
  box.replaceChildren(
    el(
      "div",
      { class: "result-head" },
      el("span", { class: `result-grade grade-${result.grade}` }, result.grade),
      el("div", {}, el("b", {}, `${last}. Blast radius ${rollout.blast.toFixed(1)} %·s`), el("small", {}, result.note), el("small", {}, "Your best grade for each level is shown in the top bar")),
    ),
    level.lesson ? el("p", { style: "margin:0" }, level.lesson) : null,
    level.inspiredBy
      ? el("small", {}, "Loosely based on: ", el("a", { href: level.inspiredBy.url, target: "_blank", rel: "noopener" }, level.inspiredBy.title))
      : null,
    isLastLevel
      ? null
      : el("div", {}, el("button", { class: "btn btn-primary", type: "button", onclick: () => call("selectLevel", state.levelIndex + 1) }, "Next level →")),
  );
}

function renderFleet() {
  const tiles = (region) =>
    state.fleet
      .filter((dc) => dc.region === region)
      .map((dc) => {
        const cls = dc.rejected ? "rejected" : dc.errorPct > 10 ? "bad" : dc.errorPct > 1 ? "warn" : dc.onNewConfig ? "new" : "";
        return el(
          "div",
          { class: `dc ${cls}`, title: `${dc.city}: ${dc.traffic}% of global traffic` },
          el("b", {}, dc.code, el("small", {}, `${dc.traffic}%`)),
          el("span", { class: "err" }, `${dc.errorPct.toFixed(1)}% err`),
        );
      });
  $("fleet").replaceChildren(
    ...REGIONS.map(([region, label]) => el("div", { class: "region" }, el("div", { class: "region-name" }, label), el("div", { class: "region-dcs" }, tiles(region)))),
  );
}

function renderSource(source) {
  const pill = $("copilot-source");
  pill.textContent = source === "llama" ? "Llama 3.3 · Workers AI" : "Offline (scripted)";
  pill.className = `pill ${source === "llama" ? "ok" : "warn"}`;
}

function renderMessage(m) {
  const body = el("span", { class: "body" });
  // Minimal formatting: `inline code` only. Everything else is plain text.
  m.text.split(/(`[^`]+`)/g).forEach((part) => {
    body.append(part.startsWith("`") && part.endsWith("`") && part.length > 2 ? el("code", {}, part.slice(1, -1)) : part);
  });
  if (m.role === "copilot") return el("div", { class: "msg copilot" }, el("span", { class: "who" }, "Co-pilot"), body);
  return el("div", { class: `msg ${m.role} ${m.tone ?? ""}` }, body);
}

function scrollChat() {
  const box = $("messages");
  requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

for (const input of document.querySelectorAll('input[name="strategy"]')) {
  input.addEventListener("change", () => call("updatePlan", { strategy: input.value }));
}
$("canary").addEventListener("change", (e) => call("updatePlan", { canary: e.target.value }));
$("bake").addEventListener("change", (e) => call("updatePlan", { bakeSec: Number(e.target.value) }));
$("deploy").addEventListener("click", () => call("deploy"));
$("proceed").addEventListener("click", () => call("proceed"));
$("rollback").addEventListener("click", () => call("rollbackNow"));
$("fail-stale").addEventListener("change", (e) => call("setFailStale", e.target.checked));
$("help-open").addEventListener("click", () => $("help").showModal());
$("reset").addEventListener("click", () => {
  if (confirm("Reset all progress, scores and chat history?")) call("reset");
});
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  call("chat", text);
  input.value = "";
});
for (const button of document.querySelectorAll("[data-say]")) {
  button.addEventListener("click", () => call("chat", button.dataset.say));
}

// Show the rules once, on the first visit.
try {
  if (!localStorage.getItem("fail-small-seen-help")) {
    $("help").showModal();
    localStorage.setItem("fail-small-seen-help", "1");
  }
} catch {}

connect();
