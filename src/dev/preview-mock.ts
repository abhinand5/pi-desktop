/**
 * Browser preview backend: a scripted Tauri for the visual pass.
 *
 * `pnpm tauri dev` runs the real backend. This module lets the same frontend
 * run in a normal Vite browser tab, where every surface can be inspected and
 * screenshotted without a native window. It implements the small part of
 * `window.__TAURI_INTERNALS__` used by the app — invoke, callback transforms,
 * and Channel delivery — then scripts plausible pi/omp responses.
 *
 * Open /preview.html and use `window.__preview` from the console:
 *   open()          open the sample project and start a runtime
 *   turn()          stream a scripted prompt/thinking/tool/reply turn
 *   approval()      surface an omp-style select dialog
 *   queue()         push steer/follow-up queue chips
 *   background()    settle a background workspace (unread + notification)
 *   speed(ms)       change scripted delta pacing
 */

import type {
  BridgeEvent,
  FsEntry,
  GitStatus,
  HarnessCommand,
  HostEntry,
  ModelInfo,
  ProviderEntry,
  SessionTree,
  SessionSummary,
  TreeNode,
} from "../lib/bridge";
import type { HarnessEvent, RuntimeInfo } from "../lib/agent-state";
import type { UsageReport } from "../lib/store/types";

// ---------- Tauri IPC plumbing ----------

type Callback = (message: unknown) => void;
type HarnessName = "pi" | "omp";
type PreviewStore = {
  getState(): {
    activeWorkspaceId: string | null;
    workspaceOrder: string[];
    workspaces: Record<string, { runtime: RuntimeInfo | null }>;
    openWorkspace(init: {
      cwd: string;
      harness?: HarnessName;
      target?: string | null;
      sessionPath?: string | null;
    }): string;
    activateWorkspace(id: string): void;
    startRuntime(): Promise<void>;
    sendPrompt(text: string): Promise<void>;
    setRoute(route: "chat" | "settings" | "usage"): void;
    setPanel(panel: "providers" | "files" | "status" | "terminal" | "tree" | null): void;
  };
};

type PreviewInternals = {
  transformCallback(callback: Callback, once?: boolean): number;
  unregisterCallback(id: number): void;
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  metadata: {
    currentWindow: { label: string };
    currentWebview: { label: string };
  };
};

const callbacks = new Map<number, Callback>();
const channelIndexes = new Map<number, number>();
const runtimes = new Map<
  string,
  { channel: number; harness: HarnessName; cwd: string; aborted: boolean }
>();
const invocationLog: Array<[string, Record<string, unknown> | undefined]> = [];
let nextCallbackId = 1;
let nextRuntimeId = 1;
let deltaDelay = 45;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function deliver(channel: number, message: unknown) {
  const callback = callbacks.get(channel);
  if (!callback) return;
  const index = channelIndexes.get(channel) ?? 0;
  channelIndexes.set(channel, index + 1);
  // Tauri Channel callbacks receive an ordered { index, message } envelope.
  callback({ index, message });
}

function emit(runtimeId: string, event: HarnessEvent) {
  const runtime = runtimes.get(runtimeId);
  if (!runtime) return;
  const frame: BridgeEvent = { kind: "event", data: event };
  deliver(runtime.channel, frame);
}

function emitExit(runtimeId: string, error: string | null = null) {
  const runtime = runtimes.get(runtimeId);
  if (!runtime) return;
  const frame: BridgeEvent = {
    kind: "exited",
    code: error ? 1 : 0,
    error,
    stderr: error ?? "",
  };
  deliver(runtime.channel, frame);
}

function response(command: Record<string, unknown>, data: unknown = {}) {
  return {
    type: "response",
    id: typeof command.id === "number" ? command.id : 0,
    success: true,
    data,
  };
}

function channelId(value: unknown): number | null {
  if (typeof value === "string" && value.startsWith("__CHANNEL__:")) {
    const id = Number(value.slice("__CHANNEL__:".length));
    return Number.isInteger(id) ? id : null;
  }
  if (value && typeof value === "object" && "id" in value) {
    const id = value.id;
    return typeof id === "number" && Number.isInteger(id) ? id : null;
  }
  return null;
}

function getStore(): PreviewStore | null {
  return (window as unknown as { __store?: PreviewStore }).__store ?? null;
}

const internals: PreviewInternals = {
  transformCallback(callback, once = false) {
    const id = nextCallbackId++;
    callbacks.set(
      id,
      once
        ? (message) => {
            callbacks.delete(id);
            callback(message);
          }
        : callback,
    );
    return id;
  },
  unregisterCallback(id) {
    callbacks.delete(id);
    channelIndexes.delete(id);
  },
  invoke(command, args) {
    invocationLog.push([command, args]);
    return Promise.resolve().then(() => handleInvoke(command, args ?? {}));
  },
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main" },
  },
};

(window as unknown as { __TAURI_INTERNALS__: PreviewInternals }).__TAURI_INTERNALS__ = internals;

// ---------- Fixture data ----------

const SAMPLE_CWD = "/home/abhinand/dev/ai/pi-desktop";
const SECOND_CWD = "/home/abhinand/dev/orca";
const SCRATCH_CWD = "/home/abhinand/.local/share/dev.pidesktop.app/scratch-workspaces";
let nextScratchSession = 1;
const SESSION_FILE = "/home/abhinand/.omp/agent/sessions/preview-session.jsonl";

const models: ModelInfo[] = [
  {
    provider: "z-ai",
    id: "glm-5.3-flash",
    name: "GLM-5.3 Flash",
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/paas/v4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 8_192,
    thinkingLevels: ["off", "minimal", "medium", "high"],
    selector: "z-ai/glm-5.3-flash",
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    api: "anthropic-messages",
    baseUrl: null,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 64_000,
    thinkingLevels: ["off", "low", "medium", "high"],
    selector: "anthropic/claude-sonnet-4-5",
  },
  {
    provider: "openai",
    id: "gpt-5-mini",
    name: "GPT-5 mini",
    api: "openai-completions",
    baseUrl: null,
    reasoning: false,
    input: ["text"],
    contextWindow: 400_000,
    maxTokens: 16_384,
    thinkingLevels: [],
    selector: "openai/gpt-5-mini",
  },
];

const commands: HarnessCommand[] = [
  { name: "compact", description: "Compact the current session", source: "extension" },
  { name: "review", description: "Review the current changes", source: "skill", location: "project" },
  { name: "tree", description: "Inspect the conversation tree", source: "prompt" },
  { name: "handoff", description: "Prepare a handoff for another agent", source: "skill" },
];

const sessions: SessionSummary[] = [
  {
    path: SESSION_FILE,
    id: "preview-session",
    cwd: SAMPLE_CWD,
    timestamp: "2026-08-31T09:12:00Z",
    name: "wire summarize setting",
    model: "glm-5.3-flash",
    version: 2,
    truncated: false,
  },
  {
    path: "/home/abhinand/.omp/agent/sessions/density-pass.jsonl",
    id: "density-pass",
    cwd: SAMPLE_CWD,
    timestamp: "2026-08-30T18:40:00Z",
    name: "rem basis fix",
    model: "claude-sonnet-4-5",
    version: 2,
    truncated: false,
  },
  {
    path: "/home/abhinand/.omp/agent/sessions/orca-session.jsonl",
    id: "orca-session",
    cwd: SECOND_CWD,
    timestamp: "2026-08-29T11:00:00Z",
    name: "terminal wheel drain",
    model: "gpt-5-mini",
    version: 2,
    truncated: true,
  },
];

const providers: ProviderEntry[] = [
  {
    id: "z-ai",
    name: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    api: "openai-completions",
    keyConfigured: true,
    modelCount: 1,
  },
  {
    id: "local",
    name: "Local gateway",
    baseUrl: "http://localhost:4000/v1",
    api: "openai-completions",
    keyConfigured: false,
    modelCount: 2,
  },
];

const hosts: HostEntry[] = [
  { alias: "build-box", destination: "build.example.com", port: 22, extraArgs: [] },
];

const fsEntries: FsEntry[] = [
  { name: "src", isDir: true, path: `${SAMPLE_CWD}/src` },
  { name: "src-tauri", isDir: true, path: `${SAMPLE_CWD}/src-tauri` },
  { name: "crates", isDir: true, path: `${SAMPLE_CWD}/crates` },
  { name: "App.tsx", isDir: false, path: `${SAMPLE_CWD}/src/App.tsx` },
  { name: "TreeRail.tsx", isDir: false, path: `${SAMPLE_CWD}/src/components/TreeRail.tsx` },
  { name: "SettingsPage.tsx", isDir: false, path: `${SAMPLE_CWD}/src/components/SettingsPage.tsx` },
  { name: "package.json", isDir: false, path: `${SAMPLE_CWD}/package.json` },
  { name: "README.md", isDir: false, path: `${SAMPLE_CWD}/README.md` },
];

function treeNodes(): TreeNode[] {
  return [
    {
      id: "n1",
      parentId: null,
      type: "message",
      role: "user",
      preview: "The settings toggle knob overflows its track",
      timestamp: "2026-08-31T08:02:00Z",
    },
    {
      id: "n2",
      parentId: "n1",
      type: "message",
      role: "assistant",
      preview: "Found it — the rem basis was rescaled…",
      model: "glm-5.3-flash",
      provider: "z-ai",
      stopReason: "stop",
      timestamp: "2026-08-31T08:03:10Z",
    },
    {
      id: "n3",
      parentId: "n2",
      type: "message",
      role: "user",
      preview: "Re-verify density across every surface",
      timestamp: "2026-08-31T08:31:00Z",
      label: "density pass",
    },
    {
      id: "n4",
      parentId: "n3",
      type: "message",
      role: "assistant",
      preview: "Walked titlebar, sidebar, transcript…",
      model: "glm-5.3-flash",
      provider: "z-ai",
      stopReason: "stop",
      timestamp: "2026-08-31T08:33:00Z",
    },
    {
      id: "n5",
      parentId: "n1",
      type: "message",
      role: "user",
      preview: "Instead: why did html font-size rescale rem?",
      timestamp: "2026-08-31T09:01:00Z",
    },
    {
      id: "n6",
      parentId: "n5",
      type: "message",
      role: "assistant",
      preview: "Tailwind spacing is rem-based…",
      model: "glm-5.3-flash",
      provider: "z-ai",
      stopReason: "stop",
      timestamp: "2026-08-31T09:02:00Z",
    },
  ];
}

const tree: SessionTree = {
  nodes: treeNodes(),
  sessionId: "preview-session",
  cwd: SAMPLE_CWD,
  name: "wire summarize setting",
  lastEntryId: "n4",
  truncated: false,
};

const historyMessages: Array<Record<string, unknown>> = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text: "The settings toggle knob overflows its track — every Tailwind size is rendering about 81%.",
      },
    ],
  },
  {
    role: "assistant",
    provider: "z-ai",
    model: "glm-5.3-flash",
    stopReason: "stop",
    content: [
      {
        type: "text",
        text: "The root `html` font-size was shrinking the rem basis. Moving the app font size to `body` keeps Tailwind geometry at its authored scale while preserving the compact reading type.",
      },
    ],
    usage: {
      input: 21_011,
      output: 1_187,
      cacheRead: 0,
      cacheWrite: 2_048,
      totalTokens: 24_246,
      cost: { total: 0.52 },
    },
  },
  {
    role: "user",
    content: [{ type: "text", text: "Good catch. Re-check every surface for density while you are in there." }],
  },
];

const THINKING =
  "I should inspect the rail and the settings boundary together. The preference already persists in the store, so the safe fix is to remove the component-local copy and make the checkbox a direct projection of that setting. Then the visual pass can verify the corrected rem geometry instead of hiding a second state bug.";

const REPLY = [
  "The setting is now one source of truth, and the density pass is ready.",
  "",
  "## What changed",
  "",
  "- `TreeRail` reads `settings.summarizeOnJump` directly.",
  "- The checkbox writes through `setSetting`, so Settings and the rail cannot drift.",
  "- The transcript keeps the branch-jump behavior unchanged.",
  "",
  "```tsx",
  "const summarize = useAppStore((s) => s.settings.summarizeOnJump);",
  "```",
  "The remaining check is visual: titlebar, sidebar, transcript, tree rail, panels, and both pages should now share the authored Tailwind spacing scale.",
].join("\n");

function chunks(text: string, width = 28): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out;
}

function modelFor(runtimeId: string) {
  const runtime = runtimes.get(runtimeId);
  return runtime?.harness === "pi"
    ? { provider: "anthropic", id: "claude-sonnet-4-5" }
    : { provider: "z-ai", id: "glm-5.3-flash" };
}

async function runTurn(runtimeId: string, prompt: string, compact = false) {
  const runtime = runtimes.get(runtimeId);
  if (!runtime) return;
  runtime.aborted = false;
  const model = modelFor(runtimeId);
  const turn = compact
    ? {
        thinking: "I am checking the compact background workspace and will leave its finished state unread in the sidebar.",
        reply: "The background workspace finished cleanly. Its unread mark should remain until you switch back.",
      }
    : { thinking: THINKING, reply: REPLY };

  emit(runtimeId, { type: "agent_start" });
  emit(runtimeId, {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  });
  emit(runtimeId, {
    type: "message_start",
    message: { role: "assistant", provider: model.provider, model: model.id, content: [] },
  });

  for (const delta of chunks(turn.thinking)) {
    if (runtime.aborted) return;
    emit(runtimeId, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
    });
    await sleep(deltaDelay);
  }
  emit(runtimeId, {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: turn.thinking },
  });

  for (const delta of chunks(turn.reply)) {
    if (runtime.aborted) return;
    emit(runtimeId, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta },
    });
    await sleep(deltaDelay);
  }

  const usage = {
    input: compact ? 4_200 : 18_432,
    output: compact ? 61 : 412,
    cacheRead: compact ? 1_200 : 9_216,
    cacheWrite: 1_024,
    totalTokens: compact ? 6_485 : 28_784,
    cost: { total: compact ? 0.04 : 0.18 },
  };
  emit(runtimeId, {
    type: "message_end",
    message: {
      role: "assistant",
      provider: model.provider,
      model: model.id,
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: turn.thinking },
        { type: "text", text: turn.reply },
        {
          type: "toolCall",
          id: "tc-1",
          name: "read",
          arguments: { path: "src/components/TreeRail.tsx" },
        },
      ],
      usage,
    },
  });

  if (!compact) {
    emit(runtimeId, {
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "read",
      args: { path: "src/components/TreeRail.tsx" },
    });
    await sleep(deltaDelay * 2);
    emit(runtimeId, {
      type: "tool_execution_update",
      toolCallId: "tc-1",
      partialResult: { content: [{ type: "text", text: "export default function TreeRail() {\n  // branch navigation\n}" }] },
    });
    await sleep(deltaDelay * 2);
    emit(runtimeId, {
      type: "tool_execution_end",
      toolCallId: "tc-1",
      result: {
        content: [
          {
            type: "text",
            text: "Read 214 lines from src/components/TreeRail.tsx",
          },
        ],
      },
      isError: false,
    });

    emit(runtimeId, {
      type: "message_start",
      message: { role: "assistant", provider: model.provider, model: model.id, content: [] },
    });
    const closing = "The file is ready for the store-backed checkbox edit.";
    for (const delta of chunks(closing, 30)) {
      if (runtime.aborted) return;
      emit(runtimeId, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
      await sleep(deltaDelay);
    }
    emit(runtimeId, {
      type: "message_end",
      message: {
        role: "assistant",
        provider: model.provider,
        model: model.id,
        stopReason: "stop",
        content: [{ type: "text", text: closing }],
        usage: { input: 18_900, output: 72, cacheRead: 9_216, cacheWrite: 0, totalTokens: 28_188, cost: { total: 0.03 } },
      },
    });
  }

  emit(runtimeId, { type: "agent_end" });
  emit(runtimeId, { type: "agent_settled" });
}

function bridgeReply(runtimeId: string, command: string, data: Record<string, unknown>) {
  emit(runtimeId, {
    type: "extension_ui_request",
    id: `notify-${command}`,
    method: "notify",
    message: `pi-desktop:${JSON.stringify({ v: 1, command, ok: true, data })}`,
  });
}

function handleRuntimeStart(args: Record<string, unknown>): RuntimeInfo {
  const id = `preview-runtime-${nextRuntimeId++}`;
  const harness: HarnessName = args.harness === "pi" ? "pi" : "omp";
  const cwd = typeof args.cwd === "string" ? args.cwd : SAMPLE_CWD;
  const channel = channelId(args.onEvent) ?? -1;
  runtimes.set(id, { channel, harness, cwd, aborted: false });

  setTimeout(() => {
    emit(id, { type: "model_changed", model: modelFor(id) });
    if (harness === "omp") emit(id, { type: "available_commands_update", commands });
  }, 650);

  return { id, harness, pid: 42_424, exited: false, host: typeof args.host === "string" ? args.host : null };
}

function handleRuntimeRequest(args: Record<string, unknown>) {
  const runtimeId = typeof args.runtimeId === "string" ? args.runtimeId : "";
  const command = (args.command ?? {}) as Record<string, unknown>;
  const type = typeof command.type === "string" ? command.type : "";

  if (type === "prompt") {
    const message = typeof command.message === "string" ? command.message : "";
    if (message.startsWith("/pd-tree")) {
      setTimeout(() => bridgeReply(runtimeId, "pd-tree", { nodes: treeNodes(), leafId: "n4", truncated: false }), 20);
    } else if (message.startsWith("/pd-state")) {
      setTimeout(() => bridgeReply(runtimeId, "pd-state", { leafId: "n4" }), 20);
    } else if (message.startsWith("/pd-goto")) {
      const entryId = message.split(/\s+/)[1] ?? "n4";
      setTimeout(
        () => bridgeReply(runtimeId, "pd-goto", { leafId: entryId, editorText: entryId === "n3" ? "Re-verify density across every surface" : null }),
        20,
      );
    } else if (message.startsWith("/pd-label")) {
      setTimeout(() => bridgeReply(runtimeId, "pd-label", { leafId: message.split(/\s+/)[1] ?? "n4" }), 20);
    } else {
      void runTurn(runtimeId, message);
    }
    return response(command);
  }

  switch (type) {
    case "get_messages":
      return response(command, { messages: historyMessages });
    case "get_state":
      return response(command, { sessionFile: SESSION_FILE, sessionName: "wire summarize setting" });
    case "get_session_stats":
      return response(command, {
        sessionFile: SESSION_FILE,
        sessionId: "preview-session",
        userMessages: 4,
        assistantMessages: 6,
        toolCalls: 9,
        totalMessages: 14,
        tokens: { input: 48_200, output: 6_431, cacheRead: 72_400, cacheWrite: 4_100, total: 131_131 },
        cost: 1.84,
        contextUsage: { tokens: 24_800, contextWindow: 200_000, percent: 12.4 },
      });
    case "get_commands":
    case "get_available_commands":
      return response(command, { commands });
    case "bash":
      return response(command, {
        output: "$ pnpm vitest run\n\n Test Files  19 passed (19)\n Tests  70 passed (70)\n",
        exitCode: 0,
        cancelled: false,
        truncated: false,
      });
    case "export_html":
      return response(command, { path: "/tmp/pi-desktop-preview.html" });
    case "get_last_assistant_text":
      return response(command, { text: REPLY });
    case "abort": {
      const runtime = runtimes.get(runtimeId);
      if (runtime) runtime.aborted = true;
      return response(command);
    }
    case "steer":
    case "follow_up":
      setTimeout(
        () =>
          emit(runtimeId, {
            type: "queue_update",
            steering: type === "steer" ? [String(command.message ?? "Inspect the rail")] : [],
            followUp: type === "follow_up" ? [String(command.message ?? "Run the visual pass")] : [],
          }),
        40,
      );
      return response(command);
    default:
      return response(command);
  }
}

function usageReport(harness: HarnessName, sinceDays: number | null): UsageReport {
  const span = sinceDays ?? 150;
  const now = new Date("2026-08-31T12:00:00Z");
  const byDay: UsageReport["byDay"] = [];
  let seed = harness === "pi" ? 17 : 31;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };

  for (let age = span - 1; age >= 0; age -= 1) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - age);
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    if (random() > (weekend ? 0.38 : 0.86)) continue;
    byDay.push({
      date: date.toISOString().slice(0, 10),
      sessions: 1 + Math.floor(random() * 4),
      messages: 8 + Math.floor(random() * 56),
      tokens: 40_000 + Math.floor(random() * 900_000),
    });
  }

  const messages = byDay.reduce((sum, day) => sum + day.messages, 0);
  const totalTokens = byDay.reduce((sum, day) => sum + day.tokens, 0);
  const sessionsCount = byDay.reduce((sum, day) => sum + day.sessions, 0);
  const input = Math.round(totalTokens * 0.58);
  const output = Math.round(totalTokens * 0.12);
  const cacheRead = Math.round(totalTokens * 0.27);
  const cacheWrite = Math.max(0, totalTokens - input - output - cacheRead);
  const dates = new Set(byDay.map((day) => day.date));
  let currentStreak = 0;
  for (let age = 0; dates.has(dateKey(now, age)); age += 1) currentStreak += 1;
  let longestStreak = 0;
  let run = 0;
  for (let age = span - 1; age >= 0; age -= 1) {
    if (dates.has(dateKey(now, age))) run += 1;
    else {
      longestStreak = Math.max(longestStreak, run);
      run = 0;
    }
  }
  longestStreak = Math.max(longestStreak, run);

  const favoriteModel = harness === "pi" ? "claude-sonnet-4-5" : "glm-5.3-flash";
  return {
    sessions: sessionsCount,
    messages,
    userMessages: Math.round(messages * 0.36),
    assistantMessages: Math.round(messages * 0.45),
    toolCalls: Math.round(messages * 0.39),
    tokens: { input, output, cacheRead, cacheWrite, total: totalTokens },
    cost: Number((totalTokens / 1_000_000 * (harness === "pi" ? 4.2 : 2.8)).toFixed(2)),
    activeDays: byDay.length,
    currentStreak,
    longestStreak,
    peakHour: 10,
    favoriteModel,
    byModel: [
      {
        model: favoriteModel,
        messages: Math.round(messages * 0.54),
        tokens: { input: Math.round(input * 0.55), output: Math.round(output * 0.55), cacheRead: Math.round(cacheRead * 0.55), cacheWrite: Math.round(cacheWrite * 0.55), total: Math.round(totalTokens * 0.55) },
        cost: 1.12,
      },
      {
        model: "claude-sonnet-4-5",
        messages: Math.round(messages * 0.31),
        tokens: { input: Math.round(input * 0.31), output: Math.round(output * 0.31), cacheRead: Math.round(cacheRead * 0.31), cacheWrite: Math.round(cacheWrite * 0.31), total: Math.round(totalTokens * 0.31) },
        cost: 0.74,
      },
      {
        model: "gpt-5-mini",
        messages: Math.max(1, messages - Math.round(messages * 0.54) - Math.round(messages * 0.31)),
        tokens: { input: Math.round(input * 0.14), output: Math.round(output * 0.14), cacheRead: Math.round(cacheRead * 0.14), cacheWrite: Math.round(cacheWrite * 0.14), total: Math.round(totalTokens * 0.14) },
        cost: 0.31,
      },
    ],
    byDay,
    firstDay: byDay[0]?.date ?? null,
    lastDay: byDay.at(-1)?.date ?? null,
  };
}

function dateKey(now: Date, age: number) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - age);
  return date.toISOString().slice(0, 10);
}

/**
 * A scripted pty, enough to check the terminal's look and wiring in a browser.
 *
 * It is a toy shell: it echoes what you type, handles backspace and Enter, and
 * knows two commands. The real one is a `portable-pty` process on the Rust
 * side, which a browser tab cannot have.
 */
const previewPtys = new Map<string, { channel: number; program: string; cwd: string; line: string }>();
let nextPtyId = 1;

/** The real pty sends bytes; `btoa` takes a Latin-1 string and throws on
 *  anything above U+00FF, so encode to UTF-8 first as the Rust side does. */
function ptyOut(id: string, text: string) {
  const pty = previewPtys.get(id);
  if (!pty) return;
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  deliver(pty.channel, { type: "output", data: btoa(binary) });
}

function ptyPrompt(id: string) {
  const pty = previewPtys.get(id);
  if (!pty) return;
  ptyOut(id, `\x1b[38;5;179m${pty.cwd.split("/").pop()}\x1b[0m \x1b[38;5;108m❯\x1b[0m `);
}

function handlePtyOpen(args: Record<string, unknown>) {
  const id = `preview-pty-${nextPtyId++}`;
  const program = typeof args.program === "string" ? args.program : "shell";
  const cwd = typeof args.cwd === "string" ? args.cwd : SAMPLE_CWD;
  previewPtys.set(id, { channel: channelId(args.onEvent) ?? -1, program, cwd, line: "" });

  setTimeout(() => {
    if (program === "shell") {
      ptyOut(id, "\x1b[2mpreview shell — try `ls` or `help`\x1b[0m\r\n");
      ptyPrompt(id);
    } else {
      ptyOut(
        id,
        `\x1b[38;5;179m  ${program === "pi" ? "π" : "◇"} ${program}\x1b[0m \x1b[2m0.83.0\x1b[0m\r\n\r\n` +
          `\x1b[2m  ${cwd}\x1b[0m\r\n\r\n` +
          `  \x1b[38;5;108m❯\x1b[0m \x1b[2mDescribe the task…\x1b[0m\r\n`,
      );
    }
  }, 120);

  return { id, program, cwd, host: typeof args.host === "string" ? args.host : null };
}

function handlePtyWrite(args: Record<string, unknown>) {
  const id = typeof args.id === "string" ? args.id : "";
  const pty = previewPtys.get(id);
  if (!pty) return null;
  const binary = atob(typeof args.data === "string" ? args.data : "");
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);

  for (const ch of text) {
    if (ch === "\r") {
      const line = pty.line.trim();
      pty.line = "";
      ptyOut(id, "\r\n");
      if (line === "help") ptyOut(id, "  ls     list files\r\n  glyphs  Nerd Font and box drawing\r\n  help   this\r\n");
      else if (line === "ls") ptyOut(id, "\x1b[38;5;110msrc\x1b[0m  \x1b[38;5;110mcrates\x1b[0m  package.json  README.md\r\n");
      else if (line === "glyphs") {
        // What a harness TUI actually draws with: private-use Nerd Font icons,
        // box rules that must join between rows, and solid blocks that must
        // fill their cell. Wrong font or wrong line height shows here first.
        // Named, because these live in the private use area and are otherwise
        // unreadable in source: U+F07B, U+F418, U+F0E7, U+F00C, U+F00D, U+F071,
        // U+E7A8, U+E628, and the powerline separator U+E0B0.
        const folder = "";
        const branch = "";
        const bolt = "";
        const check = "";
        const cross = "";
        const warn = "";
        const rust = "";
        const ts = "";
        const sep = ""; // powerline separator, drawn to fill the cell
        ptyOut(
          id,
          `  ${folder} src  ${sep}  ${branch} main   ${bolt} build\r\n` +
            `  \x1b[32m${check} done\x1b[0m  \x1b[31m${cross} fail\x1b[0m  \x1b[33m${warn} warn\x1b[0m  ${rust} rust  ${ts} ts\r\n` +
            "  ┌────────────┐  ╭────────────╮\r\n" +
            "  │ box drawing│  │ rounded    │\r\n" +
            "  └────────────┘  ╰────────────╯\r\n" +
            "  ███▓▓▓▒▒▒░░░  ▁▂▃▄▅▆▇█\r\n",
        );
      }
      else if (line) ptyOut(id, `\x1b[31mpreview: ${line}: not found\x1b[0m\r\n`);
      ptyPrompt(id);
    } else if (ch === "\x7f") {
      if (pty.line) {
        pty.line = pty.line.slice(0, -1);
        ptyOut(id, "\b \b");
      }
    } else {
      pty.line += ch;
      ptyOut(id, ch);
    }
  }
  return null;
}

function handleInvoke(command: string, args: Record<string, unknown>): unknown {
  switch (command) {
    case "pty_open":
      return handlePtyOpen(args);
    case "pty_write":
      return handlePtyWrite(args);
    case "pty_resize":
      return null;
    case "pty_kill":
      previewPtys.delete(typeof args.id === "string" ? args.id : "");
      return null;
    case "ptys_list":
      return [];
    case "runtime_start":
      return handleRuntimeStart(args);
    case "runtime_request":
      return handleRuntimeRequest(args);
    case "runtime_send":
      return null;
    case "runtime_kill": {
      const runtimeId = typeof args.runtimeId === "string" ? args.runtimeId : "";
      const runtime = runtimes.get(runtimeId);
      if (runtime) {
        runtime.aborted = true;
        emitExit(runtimeId);
      }
      return null;
    }
    case "runtimes_list":
      return [];
    case "sessions_list":
      return sessions;
    case "models_list":
      return models;
    case "scratch_workspace": {
      const root = typeof args.path === "string" && args.path.trim() ? args.path.trim() : SCRATCH_CWD;
      return `${root.replace(/[\\/]+$/, "")}/session-preview-${nextScratchSession++}`;
    }
    case "clipboard_image":
      return null;
    case "session_tree":
    case "session_tree_remote":
      return tree;
    case "session_delete":
      return null;
    case "fs_list":
    case "ssh_fs_list":
      return fsEntries;
    case "ssh_fs_read":
      return "# preview file\n\nThe browser preview serves a scripted file response.\n";
    case "git_status": {
      const status: GitStatus = { isRepo: true, branch: "main", changed: 3, staged: 1 };
      return status;
    }
    case "usage_report":
      return usageReport(args.harness === "pi" ? "pi" : "omp", typeof args.sinceDays === "number" ? args.sinceDays : null);
    case "providers_list":
      return providers;
    case "provider_upsert":
    case "provider_remove":
      return null;
    case "provider_test":
      return { ok: true, modelCount: 3, error: null };
    case "ssh_hosts_list":
      return hosts;
    case "ssh_host_add":
    case "ssh_host_remove":
      return null;
    case "ssh_host_test":
      return { reachable: true, detail: "preview host" };
    case "auth_print_key":
      return "sk-preview-key";
    case "ssh_bootstrap":
      return "preview bootstrap complete";
    case "plugin:os|platform":
      return "linux";
    case "plugin:dialog|open":
      return SAMPLE_CWD;
    case "plugin:notification|is_permission_granted":
      return true;
    case "plugin:notification|request_permission":
      return "granted";
    case "plugin:notification|notify":
      return null;
    case "plugin:event|listen":
      return nextCallbackId++;
    case "plugin:event|unlisten":
      return null;
    case "plugin:window|is_maximized":
      return false;
    case "plugin:window|minimize":
    case "plugin:window|maximize":
    case "plugin:window|unmaximize":
    case "plugin:window|toggle_maximize":
    case "plugin:window|close":
    case "plugin:window|start_dragging":
      return null;
    default:
      throw new Error(`preview mock: no handler for ${command}`);
  }
}

// ---------- Console controls ----------

function activeRuntimeId(): string | null {
  const store = getStore();
  const active = store?.getState().activeWorkspaceId;
  if (!active) return null;
  return store.getState().workspaces[active]?.runtime?.id ?? null;
}

async function openProject(cwd = SAMPLE_CWD, harness: HarnessName = "omp") {
  const store = getStore();
  if (!store) throw new Error("preview store is not ready yet");
  const id = store.getState().openWorkspace({ cwd, harness });
  await store.getState().startRuntime();
  return id;
}

async function backgroundWorkspace() {
  const store = getStore();
  if (!store) throw new Error("preview store is not ready yet");
  const first = store.getState().activeWorkspaceId;
  const second = store.getState().openWorkspace({ cwd: SECOND_CWD, harness: "omp" });
  await store.getState().startRuntime();
  const secondRuntime = store.getState().workspaces[second]?.runtime?.id;
  if (first) store.getState().activateWorkspace(first);
  if (secondRuntime) void runTurn(secondRuntime, "Check the background workspace status", true);
  return second;
}

const previewApi = {
  open: openProject,
  turn(prompt = "Please stream the density pass so I can inspect it live.") {
    const runtimeId = activeRuntimeId();
    if (!runtimeId) throw new Error("open a preview project first");
    void runTurn(runtimeId, prompt);
  },
  approval() {
    const runtimeId = activeRuntimeId();
    if (!runtimeId) throw new Error("open a preview project first");
    emit(runtimeId, {
      type: "extension_ui_request",
      id: "ui-preview-1",
      method: "select",
      title: "Approve tool execution",
      message: "The agent wants to run `pnpm vitest run`.",
      options: ["Allow once", "Always allow", "Deny"],
    });
  },
  queue() {
    const runtimeId = activeRuntimeId();
    if (!runtimeId) throw new Error("open a preview project first");
    emit(runtimeId, {
      type: "queue_update",
      steering: ["Inspect the TreeRail setting"],
      followUp: ["Run the full visual pass"],
    });
  },
  background: backgroundWorkspace,
  speed(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("speed expects a non-negative delay in milliseconds");
    deltaDelay = ms;
  },
  commands() {
    const runtimeId = activeRuntimeId();
    if (!runtimeId) throw new Error("open a preview project first");
    emit(runtimeId, { type: "available_commands_update", commands });
  },
  tree() {
    const runtimeId = activeRuntimeId();
    if (!runtimeId) throw new Error("open a preview project first");
    void handleRuntimeRequest({ runtimeId, command: { type: "prompt", message: "/pd-tree" } });
  },
  log() {
    return [...invocationLog];
  },
};

(window as unknown as { __preview: typeof previewApi }).__preview = previewApi;
