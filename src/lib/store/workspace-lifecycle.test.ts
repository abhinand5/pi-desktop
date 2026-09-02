import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../agent-store";
import { bridge } from "../bridge";
import { createWorkspace, workspaceTitle } from "./workspace";

const cwd = "/w/papers";

describe("project workspace lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({
      projects: {},
      workspaces: {},
      workspaceOrder: [],
      activeWorkspaceId: null,
      sessions: [],
      selectedSessionPath: null,
    });
  });

  it("archives the project workspace while preserving its tabs' sessions", async () => {
    const first = createWorkspace({ harness: "omp", cwd, sessionPath: "/sessions/first.jsonl" });
    const second = createWorkspace({ harness: "omp", cwd, sessionPath: "/sessions/second.jsonl" });
    const other = createWorkspace({ harness: "omp", cwd: "/w/other" });
    useAppStore.setState({
      projects: {
        [cwd]: { cwd, archived: false, kind: "folder" },
        [other.cwd]: { cwd: other.cwd, archived: false, kind: "folder" },
      },
      workspaces: { [first.id]: first, [second.id]: second, [other.id]: other },
      workspaceOrder: [first.id, second.id, other.id],
      activeWorkspaceId: first.id,
    });

    await useAppStore.getState().archiveProject(cwd);

    expect(useAppStore.getState().projects[cwd]).toEqual({ cwd, archived: true, kind: "folder" });
    expect(useAppStore.getState().workspaces[first.id]).toBeUndefined();
    expect(useAppStore.getState().workspaces[second.id]).toBeUndefined();
    expect(useAppStore.getState().workspaces[other.id]).toBeDefined();
  });

  it("deletes the project workspace without deleting its session files", async () => {
    const workspace = createWorkspace({ harness: "omp", cwd, sessionPath: "/sessions/first.jsonl" });
    const deleteSession = vi.spyOn(bridge, "deleteSession");
    const session = {
      path: "/sessions/first.jsonl",
      id: "first",
      cwd,
      name: "first prompt",
      truncated: false,
    };
    useAppStore.setState({
      projects: { [cwd]: { cwd, archived: false, kind: "folder" } },
      workspaces: { [workspace.id]: workspace },
      workspaceOrder: [workspace.id],
      activeWorkspaceId: workspace.id,
      sessions: [session],
    });

    await useAppStore.getState().deleteProject(cwd);

    expect(useAppStore.getState().projects[cwd]).toBeUndefined();
    expect(useAppStore.getState().workspaces[workspace.id]).toBeUndefined();
    expect(useAppStore.getState().sessions).toEqual([session]);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("restores an archived project workspace", () => {
    useAppStore.setState({ projects: { [cwd]: { cwd, archived: true, kind: "folder" } } });

    useAppStore.getState().restoreProject(cwd);

    expect(useAppStore.getState().projects[cwd]).toEqual({ cwd, archived: false, kind: "folder" });
  });

  it("uses the first user message line for an open workspace title", () => {
    const workspace = createWorkspace({ harness: "omp", cwd, sessionPath: "/sessions/first.jsonl" });
    workspace.agent.entries = [
      { kind: "user", seq: 1, text: ["first prompt", "second line"].join(String.fromCharCode(10)) },
    ];

    expect(workspaceTitle(workspace)).toBe("first prompt");
  });

  it("applies catalog titles to restored workspaces", async () => {
    const workspace = createWorkspace({ harness: "omp", cwd, sessionPath: "/sessions/first.jsonl" });
    vi.spyOn(bridge, "sessions").mockResolvedValue([
      {
        path: "/sessions/first.jsonl",
        id: "first",
        cwd,
        name: "first prompt",
        truncated: false,
      },
    ]);
    useAppStore.setState({
      projects: { [cwd]: { cwd, archived: false, kind: "folder" } },
      workspaces: { [workspace.id]: workspace },
      workspaceOrder: [workspace.id],
      activeWorkspaceId: workspace.id,
    });

    await useAppStore.getState().refreshSessions();

    expect(useAppStore.getState().workspaces[workspace.id].sessionName).toBe("first prompt");
  });

  it("reuses the open workspace when resuming the same session", async () => {
    const sessionPath = "/sessions/first.jsonl";
    const workspace = createWorkspace({ harness: "omp", cwd, sessionPath });
    workspace.runtime = { id: "rt-first", harness: "omp", pid: 1, exited: false, host: null };
    useAppStore.setState({
      projects: { [cwd]: { cwd, archived: false, kind: "folder" } },
      workspaces: { [workspace.id]: workspace },
      workspaceOrder: [workspace.id],
      activeWorkspaceId: workspace.id,
    });

    await useAppStore.getState().resumeSession({
      path: sessionPath,
      id: "first",
      cwd,
      truncated: false,
    });

    expect(useAppStore.getState().workspaceOrder).toEqual([workspace.id]);
    expect(useAppStore.getState().activeWorkspaceId).toBe(workspace.id);
  });

  it("opens a fresh local scratch workspace with the selected harness", async () => {
    const cwd = "/home/me/.local/share/dev.pidesktop.app/scratch-workspaces/session-test";
    const scratchWorkspace = vi.spyOn(bridge, "scratchWorkspace").mockResolvedValue(cwd);
    vi.spyOn(bridge, "startRuntime").mockResolvedValue({
      id: "rt-scratch",
      harness: "pi",
      pid: 1,
      exited: false,
      host: null,
    });
    useAppStore.setState({
      harness: "pi",
      target: "build-box",
      settings: { ...useAppStore.getState().settings, scratchWorkspacePath: "~/scratch" },
    });

    const id = await useAppStore.getState().openScratchWorkspace();
    const state = useAppStore.getState();
    const workspace = state.workspaces[id!];

    expect(workspace.cwd).toBe(cwd);
    expect(workspace.harness).toBe("pi");
    expect(workspace.target).toBeNull();
    expect(state.projects[cwd]).toEqual({ cwd, archived: false, kind: "scratch" });
    expect(scratchWorkspace).toHaveBeenCalledWith("~/scratch");
  });
});
