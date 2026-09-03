import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../agent-store";
import { bridge } from "../bridge";
import { createWorkspace, projectKey, workspaceTitle } from "./workspace";

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
        [projectKey(null, cwd)]: { cwd, target: null, archived: false, kind: "folder" },
        [projectKey(null, other.cwd)]: { cwd: other.cwd, target: null, archived: false, kind: "folder" },
      },
      workspaces: { [first.id]: first, [second.id]: second, [other.id]: other },
      workspaceOrder: [first.id, second.id, other.id],
      activeWorkspaceId: first.id,
    });

    await useAppStore.getState().archiveProject(projectKey(null, cwd));

    expect(useAppStore.getState().projects[projectKey(null, cwd)]).toEqual({ cwd, target: null, archived: true, kind: "folder" });
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
      projects: { [projectKey(null, cwd)]: { cwd, target: null, archived: false, kind: "folder" } },
      workspaces: { [workspace.id]: workspace },
      workspaceOrder: [workspace.id],
      activeWorkspaceId: workspace.id,
      sessions: [session],
    });

    await useAppStore.getState().deleteProject(projectKey(null, cwd));

    expect(useAppStore.getState().projects[projectKey(null, cwd)]).toBeUndefined();
    expect(useAppStore.getState().workspaces[workspace.id]).toBeUndefined();
    expect(useAppStore.getState().sessions).toEqual([session]);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("restores an archived project workspace", () => {
    useAppStore.setState({ projects: { [projectKey(null, cwd)]: { cwd, target: null, archived: true, kind: "folder" } } });

    useAppStore.getState().restoreProject(projectKey(null, cwd));

    expect(useAppStore.getState().projects[projectKey(null, cwd)]).toEqual({ cwd, target: null, archived: false, kind: "folder" });
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
      projects: { [projectKey(null, cwd)]: { cwd, target: null, archived: false, kind: "folder" } },
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
      projects: { [projectKey(null, cwd)]: { cwd, target: null, archived: false, kind: "folder" } },
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

  it("opens a fresh scratch workspace on this machine with the selected harness", async () => {
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
      activeMachine: null,
      settings: { ...useAppStore.getState().settings, scratchWorkspacePath: "~/scratch" },
    });

    const id = await useAppStore.getState().openScratchWorkspace();
    const state = useAppStore.getState();
    const workspace = state.workspaces[id!];

    expect(workspace.cwd).toBe(cwd);
    expect(workspace.harness).toBe("pi");
    expect(workspace.target).toBeNull();
    expect(state.projects[projectKey(null, cwd)]).toEqual({ cwd, target: null, archived: false, kind: "scratch" });
    expect(scratchWorkspace).toHaveBeenCalledWith("~/scratch", null);
  });

  it("puts a scratch session on the machine you are working on", async () => {
    // A scratch directory has to exist on the box the agent runs on, so the
    // remote makes it and the workspace belongs to that machine's project set.
    const cwd = "/home/ubuntu/.pi-desktop/scratch-workspaces/session-a1b2";
    const scratchWorkspace = vi.spyOn(bridge, "scratchWorkspace").mockResolvedValue(cwd);
    vi.spyOn(bridge, "startRuntime").mockResolvedValue({
      id: "rt-remote",
      harness: "pi",
      pid: 1,
      exited: false,
      host: "ubuntu-vm",
    });
    useAppStore.setState({
      harness: "pi",
      activeMachine: "ubuntu-vm",
      settings: { ...useAppStore.getState().settings, scratchWorkspacePath: "" },
    });

    const id = await useAppStore.getState().openScratchWorkspace();
    const state = useAppStore.getState();

    expect(state.workspaces[id!].target).toBe("ubuntu-vm");
    expect(scratchWorkspace).toHaveBeenCalledWith("", "ubuntu-vm");
    expect(state.projects[projectKey("ubuntu-vm", cwd)]).toEqual({
      cwd,
      target: "ubuntu-vm",
      archived: false,
      kind: "scratch",
    });
    // The same path on this machine is a different project entirely.
    expect(state.projects[projectKey(null, cwd)]).toBeUndefined();
  });

  it("moving between machines leaves every session alone", async () => {
    // The promise the switcher makes: machines are separate desktops. Nothing
    // is killed, nothing is re-pointed, and coming back finds your place.
    const kill = vi.spyOn(bridge, "kill").mockResolvedValue(undefined);
    const here = createWorkspace({ harness: "omp", cwd: "/w/papers" });
    here.runtime = { id: "rt-local", harness: "omp", pid: 1, exited: false, host: null };
    const there = createWorkspace({ harness: "omp", cwd: "/srv/api", target: "ubuntu-vm" });
    there.runtime = { id: "rt-remote", harness: "omp", pid: 2, exited: false, host: "ubuntu-vm" };
    useAppStore.setState({
      projects: {
        [projectKey(null, here.cwd)]: { cwd: here.cwd, target: null, archived: false, kind: "folder" },
        [projectKey("ubuntu-vm", there.cwd)]: {
          cwd: there.cwd,
          target: "ubuntu-vm",
          archived: false,
          kind: "folder",
        },
      },
      workspaces: { [here.id]: here, [there.id]: there },
      workspaceOrder: [here.id, there.id],
      activeWorkspaceId: here.id,
      activeMachine: null,
    });

    useAppStore.getState().setMachine("ubuntu-vm");

    expect(useAppStore.getState().activeMachine).toBe("ubuntu-vm");
    // Landed on that machine's own work rather than dragging this session over.
    expect(useAppStore.getState().activeWorkspaceId).toBe(there.id);
    expect(useAppStore.getState().workspaces[here.id].target).toBeNull();
    expect(useAppStore.getState().workspaces[here.id].runtime?.exited).toBe(false);
    expect(kill).not.toHaveBeenCalled();

    useAppStore.getState().setMachine(null);
    expect(useAppStore.getState().activeWorkspaceId).toBe(here.id);
    expect(useAppStore.getState().workspaces[there.id].runtime?.exited).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
