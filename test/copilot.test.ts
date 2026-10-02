import { describe, expect, it } from "vitest";
import { dropDuplicateText } from "../src/copilot";

/** Pipes SSE text through the transform, split into arbitrary chunks like a real network stream. */
async function run(chunks: string[]): Promise<string> {
  const source = new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let out = "";
  const reader = source.pipeThrough(dropDuplicateText()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += value;
  }
}

const event = (body: object) => `data: ${JSON.stringify(body)}\n\n`;

describe("dropDuplicateText", () => {
  it("keeps only delta.content when an event carries the text twice", async () => {
    const out = await run([event({ response: "Hello", choices: [{ delta: { content: "Hello" } }] })]);
    expect(out).toBe(event({ choices: [{ delta: { content: "Hello" } }] }));
  });

  it("also drops a numeric response (Workers AI sends tokens like 0 as numbers)", async () => {
    const out = await run([event({ response: 0, choices: [{ delta: { content: "0" } }] })]);
    expect(out).toBe(event({ choices: [{ delta: { content: "0" } }] }));
  });

  it("leaves events with a single text field, tool calls and [DONE] untouched", async () => {
    const input = [
      event({ response: "", usage: { total_tokens: 3 } }),
      event({ choices: [{ delta: { tool_calls: [{ function: { name: "getFleetHealth" } }] } }] }),
      event({ response: "only native" }),
      "data: [DONE]\n\n",
    ];
    expect(await run(input)).toBe(input.join(""));
  });

  it("handles events split across network chunks", async () => {
    const whole = event({ response: "Hi", choices: [{ delta: { content: "Hi" } }] });
    const out = await run([whole.slice(0, 17), whole.slice(17, 40), whole.slice(40)]);
    expect(out).toBe(event({ choices: [{ delta: { content: "Hi" } }] }));
  });
});
