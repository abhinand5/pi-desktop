import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { applyEvent } from "./agent-reducer";
import { initialState, type AgentState, type HarnessEvent } from "./agent-state";
const fixturesDir = `${process.cwd()}/crates/harness/tests/fixtures/`;

function replayFixture(name: string): AgentState {
  const lines = readFileSync(fixturesDir + name, "utf8").split("\n").filter((l) => l.trim());
  return lines.reduce((state, line) => applyEvent(state, JSON.parse(line) as HarnessEvent), initialState);
}

function lastAssistant(state: AgentState) {
  const assistants = state.entries.filter((e) => e.kind === "assistant");
  return assistants[assistants.length - 1];
}

describe("applyEvent", () => {
  it("assembles streaming text from message_update deltas (golden: pi success)", () => {
    const state = replayFixture("pi-stream-success.jsonl");
    const a = lastAssistant(state);
    expect(a).toBeDefined();
    if (a.kind !== "assistant") return;

    const text = a.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("");
    expect(text).toBe("ok");
    expect(a.streaming).toBe(false);
    expect(a.stopReason).toBe("stop");
    expect(a.usage?.totalTokens).toBe(13);
    expect(a.provider).toBe("anthropic");
    expect(state.streaming).toBe(false);
  });

  it("replays the omp golden turn (ready, deltas, agent_end)", () => {
    const state = replayFixture("omp-turn.jsonl");
    const a = lastAssistant(state);
    if (a.kind !== "assistant") throw new Error("no assistant entry");

    const text = a.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("");
    expect(text).toBe("ok");
    // omp's non-terminal agent_end was swallowed in the Rust adapter, so the
    // fixture replays a single agent_end that clears streaming.
    expect(state.streaming).toBe(false);
  });

  it.each([
    ["pi-auth-anthropic-failure.jsonl", "anthropic", "OAuth refresh failed"],
    ["pi-auth-codex-failure.jsonl", "openai-codex", "token refresh failed"],
  ])("surfaces auth failure from %s", (file, provider, fragment) => {
    const state = replayFixture(file);
    const a = lastAssistant(state);
    if (a.kind !== "assistant") throw new Error("no assistant entry");
    expect(a.stopReason).toBe("error");
    expect(a.errorMessage).toContain(fragment);
    expect(a.provider).toBe(provider);
  });

  it("builds tool cards from tool_execution events with replaced partial output", () => {
    let state = initialState;
    const evs: HarnessEvent[] = [
      { type: "agent_start" },
      {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "ls -la" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call_1",
        partialResult: { content: [{ type: "text", text: "partial out" }] },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call_1",
        partialResult: { content: [{ type: "text", text: "partial out + more" }] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        result: { content: [{ type: "text", text: "total 48" }] },
        isError: false,
      },
    ];
    for (const ev of evs) state = applyEvent(state, ev);

    const tool = state.entries.find((e) => e.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      toolCallId: "call_1",
      name: "bash",
      status: "done",
      output: "total 48",
    });
  });

  it("marks tool errors", () => {
    let state: AgentState = {
      ...initialState,
      entries: [
        {
          kind: "tool",
          seq: 1,
          toolCallId: "c1",
          name: "edit",
          args: null,
          status: "running",
          output: "",
        },
      ],
    };
    state = applyEvent(state, {
      type: "tool_execution_end",
      toolCallId: "c1",
      result: { content: [{ type: "text", text: "file not found" }] },
      isError: true,
    });
    const tool = state.entries[0];
    expect(tool.kind === "tool" && tool.status).toBe("error");
  });

  it("tracks the steering/follow-up queue from queue_update", () => {
    let state = applyEvent(initialState, {
      type: "queue_update",
      steering: ["focus on errors"],
      followUp: ["then summarize"],
    });
    expect(state.queue).toEqual({ steering: ["focus on errors"], followUp: ["then summarize"] });

    state = applyEvent(state, { type: "queue_update", steering: [], followUp: [] });
    expect(state.queue).toEqual({ steering: [], followUp: [] });
  });

  it("records compaction and retries as meta entries", () => {
    let state = applyEvent(initialState, { type: "compaction_start", reason: "threshold" });
    state = applyEvent(state, {
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      errorMessage: "529 overloaded",
    });
    expect(state.entries.at(-2)).toMatchObject({ kind: "compaction", reason: "threshold" });
    expect(state.entries.at(-1)).toMatchObject({ kind: "retry", attempt: 2, maxAttempts: 3 });
  });

  it("keeps the newest pending approval", () => {
    let state = applyEvent(initialState, {
      type: "extension_ui_request",
      id: "req-1",
      method: "select",
    });
    state = applyEvent(state, {
      type: "extension_ui_request",
      id: "req-2",
      method: "select",
    });
    expect(state.pendingApproval).toMatchObject({ requestId: "req-2", method: "select" });
  });

  it("flags lag so the UI can replay", () => {
    const state = applyEvent(initialState, { type: "runtime_lagged", lost: 12 });
    expect(state.lastError).toContain("incomplete");
  });

  it("is pure: does not mutate the previous state", () => {
    const before = structuredClone(initialState);
    applyEvent(initialState, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
    expect(initialState).toEqual(before);
  });
});

describe("blocking dialogs", () => {
  it("reads a select's real options — omp routes tool approvals through them", () => {
    const state = applyEvent(initialState, {
      type: "extension_ui_request",
      id: "req-1",
      method: "select",
      title: "Allow dangerous command?",
      options: ["Allow", "Allow for session", "Block"],
      timeout: 10000,
    });
    expect(state.pendingApproval).toEqual({
      requestId: "req-1",
      method: "select",
      title: "Allow dangerous command?",
      message: undefined,
      options: ["Allow", "Allow for session", "Block"],
      placeholder: undefined,
      prefill: undefined,
      timeout: 10000,
    });
  });

  it("carries confirm, input, and editor through with their own fields", () => {
    const confirm = applyEvent(initialState, {
      type: "extension_ui_request",
      id: "c",
      method: "confirm",
      title: "Clear session?",
      message: "All messages will be lost.",
    });
    expect(confirm.pendingApproval).toMatchObject({ method: "confirm", message: "All messages will be lost." });

    const editor = applyEvent(initialState, {
      type: "extension_ui_request",
      id: "e",
      method: "editor",
      title: "Edit",
      prefill: "line 1\nline 2",
    });
    expect(editor.pendingApproval).toMatchObject({ method: "editor", prefill: "line 1\nline 2" });
  });

  it("ignores the fire-and-forget methods, which need no answer", () => {
    for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
      const state = applyEvent(initialState, { type: "extension_ui_request", id: "x", method, message: "hi" });
      expect(state.pendingApproval).toBeNull();
    }
  });

  it("falls back to a title rather than rendering a nameless dialog", () => {
    const state = applyEvent(initialState, { type: "extension_ui_request", id: "x", method: "confirm" });
    expect(state.pendingApproval?.title).toBe("The agent needs an answer");
  });
});

describe("direct bash runs", () => {
  it("opens a run on the first chunk and appends the rest to it", () => {
    let state = applyEvent(initialState, {
      type: "bash_execution_update",
      id: "req-1",
      command: "ls -la",
      delta: "total 48\n",
    });
    state = applyEvent(state, { type: "bash_execution_update", id: "req-1", delta: "drwxr-xr-x .\n" });
    const runs = state.entries.filter((e) => e.kind === "bash");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ command: "ls -la", output: "total 48\ndrwxr-xr-x .\n", running: true });
  });

  it("keeps concurrent runs apart by their command id", () => {
    let state = applyEvent(initialState, { type: "bash_execution_update", id: "a", command: "one", delta: "1" });
    state = applyEvent(state, { type: "bash_execution_update", id: "b", command: "two", delta: "2" });
    state = applyEvent(state, { type: "bash_execution_update", id: "a", delta: "1" });
    const runs = state.entries.filter((e) => e.kind === "bash");
    expect(runs.map((r) => r.kind === "bash" && r.output)).toEqual(["11", "2"]);
  });
});
