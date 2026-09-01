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
        [cwd]: { cwd, archived: false },
        [other.cwd]: { cwd: other.cwd, archived: false },
      },
      workspaces: { [first.id]: first, [second.id]: second, [other.id]: other },
      workspaceOrder: [first.id, second.id, other.id],
      activeWorkspaceId: first.id,
    });

    await useAppStore.getState().archiveProject(cwd);

    expect(useAppStore.getState().projects[cwd]).toEqual({ cwd, archived: true });
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
      projects: { [cwd]: { cwd, archived: false } },
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
    useAppStore.setState({ projects: { [cwd]: { cwd, archived: true } } });

    useAppStore.getState().restoreProject(cwd);

    expect(useAppStore.getState().projects[cwd]).toEqual({ cwd, archived: false });
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
      projects: { [cwd]: { cwd, archived: false } },
      workspaces: { [workspace.id]: workspace },
      workspaceOrder: [workspace.id],
      activeWorkspaceId: workspace.id,
    });

    await useAppStore.getState().refreshSessions();

    expect(useAppStore.getState().workspaces[workspace.id].sessionName).toBe("first prompt");
  });
});
