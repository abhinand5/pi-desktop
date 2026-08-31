//! Pure reducer: normalized harness events → transcript state.
//!
//! The transcript is assembled from the canonical event stream
//! (message_start/update/end, tool_execution_*, queue_update, compaction,
//! retry, approvals). `message_end` content is authoritative: streaming text
//! is replaced by the final blocks when the message completes.

import type {
  AgentState,
  Approval,
  ContentBlock,
  Entry,
  HarnessEvent,
  Usage,
} from "./agent-state";

/** Omit that distributes over the Entry union instead of collapsing it. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export function applyEvent(state: AgentState, ev: HarnessEvent): AgentState {
  switch (ev.type) {
    case "agent_start":
      return { ...state, streaming: true };

    case "agent_end":
    case "agent_settled":
      return { ...state, streaming: false };

    case "message_start":
      return onMessageStart(state, ev);

    case "message_update":
      return onMessageUpdate(state, ev);

    case "message_end":
      return onMessageEnd(state, ev);

    case "tool_execution_start":
      return pushEntry(state, {
        kind: "tool",
        toolCallId: str(ev.toolCallId) ?? "",
        name: str(ev.toolName) ?? "tool",
        args: ev.args ?? null,
        status: "running",
        output: "",
      });

    case "tool_execution_update":
      return mapLastTool(state, str(ev.toolCallId) ?? "", (tool) => ({
        ...tool,
        output: contentText(ev.partialResult),
      }));

    case "tool_execution_end":
      return mapLastTool(state, str(ev.toolCallId) ?? "", (tool) => ({
        ...tool,
        status: ev.isError === true ? ("error" as const) : ("done" as const),
        output: contentText(ev.result),
      }));

    case "queue_update":
      return {
        ...state,
        queue: {
          steering: Array.isArray(ev.steering)
            ? (ev.steering as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
          followUp: Array.isArray(ev.followUp)
            ? (ev.followUp as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
        },
      };

    case "bash_execution_update": {
      const runId = str(ev.id) ?? "";
      const delta = str(ev.delta) ?? "";
      const existing = state.entries.some((e) => e.kind === "bash" && e.runId === runId);
      if (!existing) {
        return pushEntry(state, {
          kind: "bash",
          runId,
          command: str(ev.command) ?? "",
          output: delta,
          exitCode: null,
          running: true,
        });
      }
      return mapEntries(state, (entries) =>
        entries.map((e) =>
          e.kind === "bash" && e.runId === runId ? { ...e, output: e.output + delta } : e,
        ),
      );
    }

    case "compaction_start":
      return pushEntry(state, {
        kind: "compaction",
        reason: str(ev.reason) ?? "manual",
      });

    case "auto_retry_start":
      return pushEntry(state, {
        kind: "retry",
        attempt: typeof ev.attempt === "number" ? ev.attempt : 1,
        maxAttempts: typeof ev.maxAttempts === "number" ? ev.maxAttempts : 0,
        errorMessage: str(ev.errorMessage) ?? "",
      });

    case "extension_ui_request":
      return onExtensionUiRequest(state, ev);

    case "model_changed": {
      const model = ev.model as Record<string, unknown> | undefined;
      return {
        ...state,
        model: { provider: str(model?.provider), model: str(model?.id) },
      };
    }

    case "runtime_lagged":
      return { ...state, lastError: "Events were dropped while rendering — transcript may be incomplete." };

    case "response":
      // Already-correlated responses arrive as command results; stray ones
      // (fixture replays, expired correlations) are not transcript content.
      return state;

    default:
      return state;
  }
}

function onMessageStart(state: AgentState, ev: HarnessEvent): AgentState {
  const msg = ev.message as Record<string, unknown> | undefined;
  const role = str(msg?.role);
  if (role === "user") {
    return pushEntry(state, { kind: "user", text: messageText(msg) });
  }
  if (role === "assistant") {
    return pushEntry(state, {
      kind: "assistant",
      blocks: [],
      streaming: true,
      provider: str(msg?.provider),
      model: str(msg?.model),
    });
  }
  return state;
}

function onMessageUpdate(state: AgentState, ev: HarnessEvent): AgentState {
  const delta = ev.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!delta) return state;
  const index = typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
  const type = str(delta.type);

  return mapEntries(state, (entries) => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind !== "assistant" || !e.streaming) continue;
      const blocks = [...e.blocks];
      switch (type) {
        case "text_delta":
        case "thinking_delta": {
          const kind = type === "text_delta" ? "text" : "thinking";
          const block = blocks[index];
          if (block && block.kind === kind) {
            blocks[index] = { ...block, text: block.text + String(delta.delta ?? "") };
          } else {
            blocks[index] = { kind, text: String(delta.delta ?? "") } as ContentBlock;
          }
          break;
        }
        case "text_end":
        case "thinking_end": {
          const kind = type === "text_end" ? "text" : "thinking";
          blocks[index] = { kind, text: String(delta.content ?? "") } as ContentBlock;
          break;
        }
        case "toolcall_start": {
          const call = delta.partial as Record<string, unknown> | undefined;
          blocks[index] = {
            kind: "toolcall",
            id: str(call?.id) ?? "",
            name: str(call?.name) ?? "",
            args: "",
          };
          break;
        }
        case "toolcall_end": {
          const call = (delta.toolCall ?? delta.partial) as Record<string, unknown> | undefined;
          blocks[index] = {
            kind: "toolcall",
            id: str(call?.id) ?? "",
            name: str(call?.name) ?? "",
            args: JSON.stringify(call?.arguments ?? {}, null, 2),
          };
          break;
        }
        default:
          return entries;
      }
      const updated = { ...e, blocks } as Entry;
      return [...entries.slice(0, i), updated, ...entries.slice(i + 1)];
    }
    return entries;
  });
}

function onMessageEnd(state: AgentState, ev: HarnessEvent): AgentState {
  const msg = ev.message as Record<string, unknown> | undefined;
  if (str(msg?.role) !== "assistant") return state; // user messages finalize at start

  const blocks = messageBlocks(msg);
  const usage = msg?.usage as Usage | undefined;
  const stopReason = str(msg?.stopReason);
  const errorMessage = str(msg?.errorMessage);

  return mapEntries(state, (entries) => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind !== "assistant" || !e.streaming) continue;
      return [
        ...entries.slice(0, i),
        {
          ...e,
          blocks,
          streaming: false,
          stopReason,
          errorMessage,
          usage,
          provider: str(msg?.provider) ?? e.provider,
          model: str(msg?.model) ?? e.model,
        } as Entry,
        ...entries.slice(i + 1),
      ];
    }
    // message_end without a matching streaming start (replay paths).
    return [
      ...entries,
      {
        kind: "assistant",
        blocks,
        streaming: false,
        stopReason,
        errorMessage,
        usage,
        provider: str(msg?.provider),
        model: str(msg?.model),
      } as Entry,
    ];
  });
}

/** Methods that block the agent until the client answers. Everything else
 *  (notify, setStatus, setWidget, setTitle) is fire-and-forget UI chatter. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function onExtensionUiRequest(state: AgentState, ev: HarnessEvent): AgentState {
  const requestId = str(ev.id);
  const method = str(ev.method);
  if (!requestId || !method || !DIALOG_METHODS.has(method)) return state;

  const approval: Approval = {
    requestId,
    method: method as Approval["method"],
    title: str(ev.title) ?? "The agent needs an answer",
    message: str(ev.message),
    // select answers are the option string itself, so the real list has to
    // reach the UI — an index would be answering a different question.
    options: Array.isArray(ev.options)
      ? ev.options.filter((o): o is string => typeof o === "string")
      : undefined,
    placeholder: str(ev.placeholder),
    prefill: str(ev.prefill),
    timeout: typeof ev.timeout === "number" ? ev.timeout : undefined,
  };
  // omp surfaces tool approvals as select dialogs; keep the newest pending.
  return { ...state, pendingApproval: approval };
}

// ---------- helpers ----------

function pushEntry(state: AgentState, entry: DistributiveOmit<Entry, "seq">): AgentState {
  const seq = state.seq + 1;
  return { ...state, seq, entries: [...state.entries, { ...entry, seq } as Entry] };
}

function mapEntries(state: AgentState, fn: (entries: Entry[]) => Entry[]): AgentState {
  const entries = fn(state.entries);
  return entries === state.entries ? state : { ...state, entries };
}

function mapLastTool(
  state: AgentState,
  toolCallId: string,
  fn: (tool: Extract<Entry, { kind: "tool" }>) => Extract<Entry, { kind: "tool" }>,
): AgentState {
  return mapEntries(state, (entries) => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind === "tool" && e.toolCallId === toolCallId) {
        const updated = fn(e);
        if (updated === e) return entries;
        return [...entries.slice(0, i), updated, ...entries.slice(i + 1)];
      }
    }
    return entries;
  });
}

function messageText(msg: Record<string, unknown> | undefined): string {
  const blocks = (msg?.content as Array<Record<string, unknown>> | undefined) ?? [];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("")
    .trim();
}

function messageBlocks(msg: Record<string, unknown> | undefined): ContentBlock[] {
  const raw = (msg?.content as Array<Record<string, unknown>> | undefined) ?? [];
  const out: ContentBlock[] = [];
  for (const b of raw) {
    if (b.type === "text") {
      const text = String(b.text ?? "");
      if (text) out.push({ kind: "text", text });
    } else if (b.type === "thinking") {
      const text = String(b.thinking ?? "");
      if (text) out.push({ kind: "thinking", text });
    } else if (b.type === "toolCall") {
      out.push({
        kind: "toolcall",
        id: String(b.id ?? ""),
        name: String(b.name ?? ""),
        args: JSON.stringify(b.arguments ?? {}, null, 2),
      });
    }
  }
  return out;
}

function contentText(result: unknown): string {
  const r = result as Record<string, unknown> | undefined | null;
  if (!r) return "";
  const content = r.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text")
    .map((c) => String(c.text ?? ""))
    .join("");
}

/** Narrowing guard used across many event-field extraction sites. */
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
