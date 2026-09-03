import { beforeEach, describe, expect, it, vi } from "vitest";
import { asModelInfo } from "../agent-state";
import { useAppStore } from "../agent-store";
import { bridge, type DefaultModelRef } from "../bridge";

const cwd = "/w/defaults";
const RUNTIME = { id: "runtime-1", harness: "omp", pid: 1, exited: false, host: null } as const;

/** The default model fixture the tests share. */
const DEFAULT_MODEL: DefaultModelRef = { provider: "z-ai", id: "glm-5.3-flash", thinking: "max" };

/** Mocks everything one spawn touches, so openWorkspace can run for real. */
function mockSpawnBridge() {
  vi.spyOn(bridge, "startRuntime").mockResolvedValue({ ...RUNTIME });
  vi.spyOn(bridge, "request").mockResolvedValue({});
  vi.spyOn(bridge, "sessionTree").mockResolvedValue({ nodes: [], truncated: false });
  vi.spyOn(bridge, "models").mockResolvedValue([]);
  vi.spyOn(bridge, "sessions").mockResolvedValue([]);
}

const settled = (check: () => void) => vi.waitFor(check, { timeout: 1_000, interval: 10 });

describe("harness default model", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({
      projects: {},
      workspaces: {},
      workspaceOrder: [],
      activeWorkspaceId: null,
      sessions: [],
      selectedSessionPath: null,
      harness: "omp",
      harnessDefault: null,
      selectedModel: null,
    });
  });

  it("seeds every fresh session with the harness's own default model", async () => {
    mockSpawnBridge();
    const start = vi.spyOn(bridge, "startRuntime").mockResolvedValue({ ...RUNTIME });
    useAppStore.setState({ harnessDefault: DEFAULT_MODEL });

    useAppStore.getState().openWorkspace({ cwd, fresh: true });
    await settled(() => {
      // The workspace was created on the default, and the spawn asked the
      // harness for it explicitly.
      expect(useAppStore.getState().selectedModel).toEqual(asModelInfo(DEFAULT_MODEL));
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ model: "z-ai/glm-5.3-flash" }));
    });

    // A second fresh workspace in another folder starts on the same default
    // rather than inheriting the previous session's chip.
    useAppStore.getState().openWorkspace({ cwd: "/w/other", fresh: true });
    await settled(() => {
      expect(useAppStore.getState().selectedModel).toEqual(asModelInfo(DEFAULT_MODEL));
      expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ model: "z-ai/glm-5.3-flash" }));
    });
  });

  it("resuming a session keeps the workspace's current model", async () => {
    mockSpawnBridge();
    const start = vi.spyOn(bridge, "startRuntime").mockResolvedValue({ ...RUNTIME });
    useAppStore.setState({ harnessDefault: DEFAULT_MODEL });
    const resumed = { ...asModelInfo(DEFAULT_MODEL)!, provider: "anthropic", id: "claude-opus-4-8" };
    useAppStore.setState({ selectedModel: resumed });

    useAppStore.getState().openWorkspace({ cwd, sessionPath: "/sessions/one.jsonl" });
    await settled(() => {
      expect(useAppStore.getState().selectedModel).toEqual(resumed);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ model: "anthropic/claude-opus-4-8" }));
    });
  });

  it("reads the default from the harness and writes changes back through", async () => {
    let stored: DefaultModelRef | null = null;
    vi.spyOn(bridge, "harnessDefaultModel").mockImplementation(async () => stored);
    vi.spyOn(bridge, "setHarnessDefaultModel").mockImplementation(async (_harness, model) => {
      stored = model;
    });

    await useAppStore.getState().loadHarnessDefault();
    expect(useAppStore.getState().harnessDefault).toBeNull();

    await useAppStore.getState().setDefaultModel(DEFAULT_MODEL);
    expect(useAppStore.getState().harnessDefault).toEqual(DEFAULT_MODEL);

    await useAppStore.getState().setDefaultModel(null);
    expect(useAppStore.getState().harnessDefault).toBeNull();
  });
});

describe("usage harness selection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({ usage: null, usageHarness: "all", usageError: null });
  });

  it("loads the report for the selected agent, defaulting to both", async () => {
    const report = {
      sessions: 1,
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      cost: 0,
      activeDays: 1,
      currentStreak: 1,
      longestStreak: 1,
      peakHour: null,
      favoriteModel: null,
      byModel: [],
      byMachine: [],
  unreachable: [],
  byDay: [],
      firstDay: null,
      lastDay: null,
    };
    const usage = vi.spyOn(bridge, "usageReport").mockResolvedValue({ ...report });

    expect(useAppStore.getState().usageHarness).toBe("all");
    await useAppStore.getState().loadUsage();
    expect(usage).toHaveBeenCalledWith("all", null);

    useAppStore.getState().setUsageHarness("pi");
    await settled(() => {
      expect(usage).toHaveBeenLastCalledWith("pi", null);
    });
    expect(useAppStore.getState().usageHarness).toBe("pi");
  });
});
