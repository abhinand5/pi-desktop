/** Live runtime descriptor from the Rust bridge. */
export interface RuntimeInfo {
  id: string;
  harness: string;
  pid: number | null;
  exited: boolean;
  host: string | null;
}
/** Catalog model, normalized across harnesses. */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  api: string;
  baseUrl: string | null;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevels: string[];
  selector: string | null;
}

/** Session file summary from the read-only catalog scan. */
export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  timestamp?: string;
  name?: string;
  model?: string;
  version?: number;
  truncated: boolean;
}

export type HarnessEvent = { type: string } & Record<string, unknown>;

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolcall"; id: string; name: string; args: string };

export type Entry =
  | { kind: "user"; seq: number; text: string }
  | {
      kind: "assistant";
      seq: number;
      blocks: ContentBlock[];
      streaming: boolean;
      stopReason?: string;
      errorMessage?: string;
      model?: string;
      provider?: string;
      usage?: Usage;
    }
  | {
      kind: "tool";
      seq: number;
      toolCallId: string;
      name: string;
      args: unknown;
      status: "running" | "done" | "error";
      output: string;
    }
  | { kind: "compaction"; seq: number; reason: string }
  | { kind: "bash"; seq: number; runId: string; command: string; output: string; exitCode: number | null; running: boolean }
  | { kind: "retry"; seq: number; attempt: number; maxAttempts: number; errorMessage: string };

/** A dialog the agent is blocked on. omp routes tool approvals through
 *  `select`, so answering the wrong shape silently denies real work. */
export interface Approval {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  /** select only — the answer is one of these strings, never an index. */
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** ms, after which the agent resolves the dialog itself. */
  timeout?: number;
}

/** A shell command the user ran directly, streaming its output. */
export interface BashRun {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  running: boolean;
}

export interface AgentState {
  entries: Entry[];
  streaming: boolean;
  queue: { steering: string[]; followUp: string[] };
  pendingApproval: Approval | null;
  lastError: string | null;
  model: { provider?: string; model?: string } | null;
  seq: number;
}

export const initialState: AgentState = {
  entries: [],
  streaming: false,
  queue: { steering: [], followUp: [] },
  pendingApproval: null,
  lastError: null,
  model: null,
  seq: 0,
};
