import { invoke, Channel } from "@tauri-apps/api/core";
import type { HarnessEvent, ModelInfo, RuntimeInfo, SessionSummary } from "./agent-state";
import type { UsageReport } from "./store/types";

export type { HarnessEvent, ModelInfo, RuntimeInfo, SessionSummary };
export type HarnessId = "pi" | "omp";

/** Frames pushed from the Rust runtime bridge. */
export type BridgeEvent =
  | { kind: "event"; data: HarnessEvent }
  | { kind: "exited"; code: number | null; error: string | null; stderr: string };

export interface StartOptions {
  harness: HarnessId;
  cwd: string;
  host?: string | null;
  egress?: boolean | null;
  brokerEnv?: Record<string, string> | null;
  sessionPath?: string | null;
  model?: string | null;
  thinking?: string | null;
  approvalMode?: string | null;
  noSession?: boolean;
  continueLast?: boolean;
  onEvent: (ev: BridgeEvent) => void;
}

/** Registered SSH execution host. */
export interface HostEntry {
  alias: string;
  destination: string;
  port?: number | null;
  extraArgs?: string[];
}

export interface HostProbe {
  reachable: boolean;
  detail: string;
}

export interface FsEntry {
  name: string;
  isDir: boolean;
  path: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  changed: number;
  staged: number;
}

/** Stored custom-provider descriptor (secrets never leave the backend). */
export interface ProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  keyConfigured: boolean;
  modelCount: number;
}

/** Config payload written to the harness's native models config. */
export interface ProviderConfig {
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: Array<{ id: string; reasoning?: boolean }>;
}

export interface ProviderTestResult {
  ok: boolean;
  modelCount: number | null;
  error: string | null;
}
/** The harness's own default model, read from its native config — pi's
 *  `settings.json` or omp's `config.yml`. What every new session starts on. */
export interface DefaultModelRef {
  provider: string;
  id: string;
  /** Informational: pi's defaultThinkingLevel or an omp role's `:level`. */
  thinking?: string | null;
}

/** One session entry, projected for the tree. Emitted identically by the Rust
 *  JSONL reader and by the bundled bridge extension, so the UI has one node
 *  type no matter where the tree came from. */
export interface TreeNode {
  id: string;
  parentId: string | null;
  type: string;
  timestamp?: string;
  role?: string;
  preview: string;
  toolName?: string;
  isError?: boolean;
  toolCalls?: string[];
  model?: string;
  provider?: string;
  stopReason?: string;
  customType?: string;
  fromId?: string;
  label?: string;
}

export interface SessionTree {
  nodes: TreeNode[];
  sessionId?: string;
  cwd?: string;
  name?: string;
  parentSession?: string;
  /** Last *appended* entry — the leaf only until someone navigates. While a
   *  runtime is attached the live leaf comes from the harness instead. */
  lastEntryId?: string;
  truncated: boolean;
}

/** A slash command offered to the composer. */
export interface HarnessCommand {
  name: string;
  description?: string;
  /** extension | prompt | skill, per the harness's own classification. */
  source?: string;
  location?: string;
  path?: string;
}

/** What a terminal runs. The harness options start the real TUI, not the RPC
 *  mode the chat drives. */
export type PtyProgram = "shell" | "pi" | "omp";

export type PtyEvent =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

export interface PtyInfo {
  id: string;
  program: PtyProgram;
  cwd: string;
  host: string | null;
}

export const bridge = {
  async startRuntime(opts: StartOptions): Promise<RuntimeInfo> {
    const channel = new Channel<BridgeEvent>();
    channel.onmessage = opts.onEvent;
    return invoke("runtime_start", {
      harness: opts.harness,
      cwd: opts.cwd,
      host: opts.host ?? null,
      egress: opts.egress ?? null,
      brokerEnv: opts.brokerEnv ?? null,
      sessionPath: opts.sessionPath ?? null,
      model: opts.model ?? null,
      thinking: opts.thinking ?? null,
      approvalMode: opts.approvalMode ?? null,
      noSession: opts.noSession ?? false,
      continueLast: opts.continueLast ?? false,
      onEvent: channel,
    });
  },

  /**
   * Opens a real pseudo-terminal. Bytes arrive base64-encoded and are handed
   * to the emulator untouched: a read can land mid-escape-sequence or
   * mid-codepoint, and only the emulator can reassemble them.
   */
  async openPty(opts: {
    program: PtyProgram;
    cwd: string;
    host?: string | null;
    cols: number;
    rows: number;
    onEvent: (ev: PtyEvent) => void;
  }): Promise<PtyInfo> {
    const channel = new Channel<PtyEvent>();
    channel.onmessage = opts.onEvent;
    return invoke("pty_open", {
      program: opts.program,
      cwd: opts.cwd,
      host: opts.host ?? null,
      cols: opts.cols,
      rows: opts.rows,
      onEvent: channel,
    });
  },

  writePty(id: string, data: string): Promise<void> {
    return invoke("pty_write", { id, data });
  },

  resizePty(id: string, cols: number, rows: number): Promise<void> {
    return invoke("pty_resize", { id, cols, rows });
  },

  async killPty(id: string): Promise<void> {
    await invoke("pty_kill", { id });
  },

  request(runtimeId: string, command: Record<string, unknown>): Promise<unknown> {
    return invoke("runtime_request", { runtimeId, command });
  },

  send(runtimeId: string, command: Record<string, unknown>): Promise<void> {
    return invoke("runtime_send", { runtimeId, command });
  },

  async kill(runtimeId: string): Promise<void> {
    await invoke("runtime_kill", { runtimeId });
  },

  async sessions(harness: HarnessId): Promise<SessionSummary[]> {
    return invoke("sessions_list", { harness });
  },

  /** Creates a fresh scratch session directory on the machine it will run on. */
  async scratchWorkspace(path?: string | null, host?: string | null): Promise<string> {
    return invoke("scratch_workspace", { path: path?.trim() || null, host: host ?? null });
  },

  /** Reads a still image from the OS clipboard without involving webview permissions. */
  async clipboardImage(): Promise<ClipboardImage | null> {
    return invoke("clipboard_image");
  },

  /** The catalog of the machine the agent runs on: a remote box has its own
   *  providers and its own configured models. */
  async models(harness: HarnessId, host?: string | null): Promise<ModelInfo[]> {
    return invoke("models_list", { harness, host: host ?? null });
  },


  /** Reads a session's tree from its file — no runtime required, so a session
   *  can be previewed before it is opened. */
  async sessionTree(path: string): Promise<SessionTree> {
    return invoke("session_tree", { path });
  },

  async sessionTreeRemote(host: string, port: number | null, path: string): Promise<SessionTree> {
    return invoke("session_tree_remote", { host, port, path });
  },

  /** Removes a session file, via `trash` when it is installed. */
  async deleteSession(path: string): Promise<void> {
    await invoke("session_delete", { path });
  },

  /** Local directory listing for the composer's `@` file picker. */
  async fsList(path: string): Promise<FsEntry[]> {
    return invoke("fs_list", { path });
  },

  async gitStatus(cwd: string): Promise<GitStatus> {
    return invoke("git_status", { cwd });
  },

  /** The harness-level default model, read from its native config. */
  async harnessDefaultModel(harness: HarnessId): Promise<DefaultModelRef | null> {
    return invoke("harness_default_model", { harness });
  },

  /** Writes the harness-level default model into the harness's own config, so
   *  the CLI starts on it too. `null` clears it. */
  async setHarnessDefaultModel(harness: HarnessId, model: DefaultModelRef | null): Promise<void> {
    return invoke("harness_default_model_set", { harness, model });
  },

  /** Aggregate usage across the sessions the given agent (or both) wrote. */
  /** Usage across every machine: this one and every registered host. Pass
   *  `hosts` to narrow it; omit for all of them. */
  async usageReport(
    harness: HarnessId | "all",
    sinceDays: number | null,
    hosts?: string[] | null,
  ): Promise<UsageReport> {
    return invoke("usage_report", { harness, sinceDays, hosts: hosts ?? null });
  },

  // ---- provider onboarding (native config formats) ----

  async providers(harness: HarnessId): Promise<ProviderEntry[]> {
    return invoke("providers_list", { harness });
  },

  async upsertProvider(harness: HarnessId, id: string, config: ProviderConfig): Promise<void> {
    await invoke("provider_upsert", { harness, id, config });
  },

  async removeProvider(harness: HarnessId, id: string): Promise<void> {
    await invoke("provider_remove", { harness, id });
  },

  async testProvider(baseUrl: string, apiKey: string | null): Promise<ProviderTestResult> {
    return invoke("provider_test", { baseUrl, apiKey });
  },

  // ---- ssh execution hosts ----

  async sshHosts(): Promise<HostEntry[]> {
    return invoke("ssh_hosts_list");
  },

  async sshHostAdd(alias: string, destination: string, port: number | null): Promise<void> {
    await invoke("ssh_host_add", { alias, destination, port });
  },

  async sshHostRemove(alias: string): Promise<void> {
    await invoke("ssh_host_remove", { alias });
  },

  async sshHostTest(host: string, port: number | null): Promise<HostProbe> {
    return invoke("ssh_host_test", { host, port });
  },

  // ---- remote file browsing ----

  async sshFsList(host: string, port: number | null, path: string): Promise<FsEntry[]> {
    return invoke("ssh_fs_list", { host, port, path });
  },

  async sshFsRead(host: string, port: number | null, path: string): Promise<string> {
    return invoke("ssh_fs_read", { host, port, path });
  },

  // ---- offline remote: auth broker + remote bootstrap ----

  /** Resolves a stored key through the pi harness's own credential interface. */
  async authPrintKey(provider: string): Promise<string> {
    return invoke("auth_print_key", { provider });
  },

  /** Installs the harness on a remote host through the egress tunnel. */
  async sshBootstrap(harness: HarnessId, host: string, port: number | null): Promise<string> {
    return invoke("ssh_bootstrap", { harness, host, port });
  },
};

/** Builds RPC commands (ids are assigned by the Rust client). */
export const rpc = {
  prompt: (message: string) => ({ type: "prompt", message }),
  steer: (message: string) => ({ type: "steer", message }),
  followUp: (message: string) => ({ type: "follow_up", message }),
  abort: () => ({ type: "abort" }),
  getState: () => ({ type: "get_state" }),
  getMessages: () => ({ type: "get_messages" }),
  getSessionStats: () => ({ type: "get_session_stats" }),
  setModel: (provider: string, modelId: string) => ({ type: "set_model", provider, modelId }),
  setThinkingLevel: (level: string) => ({ type: "set_thinking_level", level }),

  compact: (message?: string) => (message ? { type: "compact", message } : { type: "compact" }),
  newSession: () => ({ type: "new_session" }),
  setSessionName: (name: string) => ({ type: "set_session_name", name }),
  switchSession: (sessionPath: string) => ({ type: "switch_session", sessionPath }),
  exportHtml: (outputPath?: string) =>
    outputPath ? { type: "export_html", outputPath } : { type: "export_html" },
  /** pi: fork; omp: branch (renamed by the Rust harness adapter). */
  fork: (entryId: string) => ({ type: "fork", entryId }),
  clone: () => ({ type: "clone" }),
  bash: (command: string) => ({ type: "bash", command }),
  abortBash: () => ({ type: "abort_bash" }),
  getLastAssistantText: () => ({ type: "get_last_assistant_text" }),

  /** pi only. omp answers get_available_commands; neither answers both. */
  getCommands: () => ({ type: "get_commands" }),
  getAvailableCommands: () => ({ type: "get_available_commands" }),
  /** pi only — omp has no tree RPC, so the bridge extension covers it. */
  getTree: () => ({ type: "get_tree" }),
  getEntries: (since?: string) => (since ? { type: "get_entries", since } : { type: "get_entries" }),

  /** Attachments ride along with the prompt as ImageContent blocks. */
  promptWith: (message: string, images: ImageAttachment[], streamingBehavior?: "steer" | "followUp") => ({
    type: "prompt",
    message,
    ...(images.length ? { images } : {}),
    ...(streamingBehavior ? { streamingBehavior } : {}),
  }),
};

export interface ImageAttachment {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ClipboardImage {
  data: string;
  mimeType: string;
}

/**
 * The bridge extension's reply channel.
 *
 * Session-tree navigation exists only in the harness extension API, so the
 * desktop ships an extension and drives it over the ordinary `prompt` command.
 * Replies come back as fire-and-forget `notify` dialogs carrying this prefix;
 * the reducer parses them and swallows the frame so they never reach the
 * transcript as chatter.
 */
export const BRIDGE_PREFIX = "pi-desktop:";

export type BridgeReplyCommand = "pd-state" | "pd-tree" | "pd-goto" | "pd-label";

export interface BridgeReply {
  v: number;
  command: BridgeReplyCommand;
  ok: boolean;
  data: Record<string, unknown>;
}

export function parseBridgeReply(message: unknown): BridgeReply | null {
  if (typeof message !== "string" || !message.startsWith(BRIDGE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(message.slice(BRIDGE_PREFIX.length)) as BridgeReply;
    return parsed && typeof parsed.command === "string" ? parsed : null;
  } catch {
    // A notify that merely looks like ours is still the user's to read.
    return null;
  }
}

/** Commands the desktop drives through the bridge extension. */
export const bridgeCmd = {
  state: () => "/pd-state",
  tree: () => "/pd-tree",
  goto: (entryId: string, summarize?: { customInstructions?: string }) =>
    summarize
      ? `/pd-goto ${entryId} --summarize${summarize.customInstructions ? `=${summarize.customInstructions}` : ""}`
      : `/pd-goto ${entryId}`,
  label: (entryId: string, label: string) => `/pd-label ${entryId}${label ? ` ${label}` : ""}`,
};

/** Bridge commands are plumbing, not user-facing vocabulary. */
export const BRIDGE_COMMAND_NAMES = new Set(["pd-state", "pd-tree", "pd-goto", "pd-label"]);
