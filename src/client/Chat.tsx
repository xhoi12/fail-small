// The co-pilot chat, built on useAgentChat (@cloudflare/ai-chat/react).
//
// Message parts are rendered by kind:
//   - text: the co-pilot's words, streamed as they arrive;
//   - read-only tool calls (getFleetHealth, …): a small "looked at …" chip;
//   - action tool calls (rollBack, …): an approval card. The co-pilot can only
//     propose; nothing happens until the player presses Approve.
// Turns the game starts on its own begin with a hidden message, which isn't shown.

import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { useAgent } from "agents/react";
import { getToolName, isToolUIPart } from "ai";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ACTION_TOOLS, type ActionTool, type ChatMessage } from "../shared";

type ToolPart = Extract<ChatMessage["parts"][number], { toolCallId: string }>;

const LOOKUPS: Record<string, string> = {
  getRolloutStatus: "Checked the rollout status",
  getFleetHealth: "Checked fleet health",
  getDatacenter: "Looked at a datacenter's history",
  getPastRollouts: "Remembered your earlier rollouts",
};

const QUICK = [
  { label: "review", text: "review" },
  { label: "status", text: "status" },
  { label: "which canary?", text: "Which canary would you pick for this change, and why?" },
  { label: "anything off?", text: "Is anything elevated compared to baseline right now?" },
];

export function Chat({ agent, mode }: { agent: ReturnType<typeof useAgent>; mode: "llama" | "offline" | null }) {
  const { messages, sendMessage, addToolApprovalResponse, isStreaming } = useAgentChat<unknown, ChatMessage>({ agent });
  const [input, setInput] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const visible = messages.filter((m) => !m.metadata?.hidden);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [messages, isStreaming]);

  const send = (text: string) => {
    if (text.trim()) sendMessage({ text: text.trim() });
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
    setInput("");
  };

  return (
    <aside className="copilot" aria-label="Co-pilot chat">
      <header className="copilot-head">
        <span className="copilot-avatar" aria-hidden="true">AI</span>
        <div>
          <b>Co-pilot</b>
          <small>Reviews the change, watches the fleet, proposes actions. It can be wrong.</small>
        </div>
        {mode && (
          <span
            className={`pill ${mode === "llama" ? "ok" : "warn"}`}
            title={mode === "llama" ? "Llama 3.3 70B on Workers AI" : "Run `npx wrangler login` and restart for Llama 3.3"}
          >
            {mode === "llama" ? "Llama 3.3" : "Offline"}
          </span>
        )}
      </header>
      <div ref={box} className="messages" aria-live="polite">
        {visible.map((message) => (
          <Message
            key={message.id}
            message={message}
            onApprove={(id, approved) => addToolApprovalResponse({ id, approved })}
          />
        ))}
        {isStreaming && (
          <div className="typing" aria-label="Co-pilot is thinking">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      <div className="quick">
        {QUICK.map((q) => (
          <button key={q.label} type="button" onClick={() => send(q.text)}>
            {q.label}
          </button>
        ))}
      </div>
      <form className="composer" onSubmit={onSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoComplete="off"
          placeholder="Ask the co-pilot, or type deploy / proceed / rollback"
          maxLength={1000}
        />
        <button className="btn btn-primary" type="submit">
          Send
        </button>
      </form>
    </aside>
  );
}

function Message({ message, onApprove }: { message: ChatMessage; onApprove: (id: string, approved: boolean) => void }) {
  if (message.role === "user") {
    return <div className="msg user">{message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</div>;
  }
  return (
    <div className="msg assistant">
      {message.parts.map((part, i) => {
        if (part.type === "text") return <Text key={i} text={part.text} />;
        if (isToolUIPart(part)) {
          const name = getToolName(part);
          return ACTION_TOOLS.includes(name as ActionTool) ? (
            <ActionCard key={part.toolCallId} name={name as ActionTool} part={part as ToolPart} onApprove={onApprove} />
          ) : (
            <span key={part.toolCallId} className={`tool-chip${part.state === "output-available" ? " done" : ""}`}>
              {LOOKUPS[name] ?? name}
            </span>
          );
        }
        return null;
      })}
    </div>
  );
}

/** Plain text with `inline code`. The co-pilot is asked not to use other markdown. */
function Text({ text }: { text: string }) {
  return (
    <span className="body">
      {text.split(/(`[^`]+`)/g).map((chunk, i) =>
        chunk.length > 2 && chunk.startsWith("`") && chunk.endsWith("`") ? <code key={i}>{chunk.slice(1, -1)}</code> : chunk,
      )}
    </span>
  );
}

function describeAction(name: ActionTool, input: Record<string, unknown>): string {
  switch (name) {
    case "rollBack":
      return "Roll back the change everywhere";
    case "proceedRollout":
      return "Proceed to the next stage";
    case "deployChange":
      return "Deploy the change with the current plan";
    case "setRolloutPlan": {
      const changes = [
        input.strategy && `strategy ${input.strategy}`,
        input.canary && `canary ${input.canary}`,
        input.bakeSec && `bake ${input.bakeSec}s`,
      ].filter(Boolean);
      return `Change the plan: ${changes.join(", ") || "no changes"}`;
    }
  }
}

/** A co-pilot proposal. Approve runs the tool on the server; Reject tells the co-pilot no. */
function ActionCard({
  name,
  part,
  onApprove,
}: {
  name: ActionTool;
  part: ToolPart;
  onApprove: (id: string, approved: boolean) => void;
}) {
  const input = (part.input ?? {}) as Record<string, unknown>;
  const output = part.state === "output-available" ? (part.output as { result?: string } | undefined) : undefined;
  return (
    <div className={`action-card ${part.state}`}>
      <div className="action-title">Co-pilot proposes: {describeAction(name, input)}</div>
      {typeof input.reason === "string" && <div className="action-reason">“{input.reason}”</div>}
      {part.state === "approval-requested" && (
        <div className="action-buttons">
          <button type="button" className="btn btn-primary" onClick={() => onApprove(part.approval.id, true)}>
            Approve
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => onApprove(part.approval.id, false)}>
            Reject
          </button>
        </div>
      )}
      {part.state === "approval-responded" && <div className="action-status">{part.approval.approved ? "Approved…" : "Rejected"}</div>}
      {output && <div className="action-status ok">✓ Approved. {output.result}</div>}
      {part.state === "output-denied" && (
        <div className="action-status">✕ {part.approval?.reason ?? "Rejected"}</div>
      )}
      {part.state === "output-error" && <div className="action-status bad">⚠ {part.errorText}</div>}
    </div>
  );
}
