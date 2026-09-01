import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../agent-store";
import { bridge } from "../bridge";
import { createWorkspace } from "./workspace";

/**
 * Opening a workspace is a request to work in it, so the agent starts on its
 * own. The cases it must *not* start are the point of these tests.
 */
describe("starting a workspace by opening it", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({ workspaces: {}, workspaceOrder: [], activeWorkspaceId: null, models: [] });
  });

  function stubSpawn() {
    return vi.spyOn(bridge, "startRuntime").mockResolvedValue({
      id: "rt-1",
      harness: "omp",
      pid: 1,
      exited: false,
      host: null,
    });
  }

  it("starts a chat workspace the moment it is opened", () => {
    const start = stubSpawn();
    useAppStore.getState().openWorkspace({ cwd: "/w/papers" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0].cwd).toBe("/w/papers");
  });

  it("starts a remembered workspace on the session it was left on", () => {
    const start = stubSpawn();
    const w = createWorkspace({ harness: "omp", cwd: "/w/papers", sessionPath: "/s/a.jsonl" });
    useAppStore.setState({ workspaces: { [w.id]: w }, workspaceOrder: [w.id], activeWorkspaceId: null });

    useAppStore.getState().activateWorkspace(w.id);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0].sessionPath).toBe("/s/a.jsonl");
  });

  it("does not respawn a workspace whose last start failed", () => {
    const start = stubSpawn();
    const w = createWorkspace({ harness: "omp", cwd: "/w/papers" });
    w.connectionError = "omp is not on your PATH";
    useAppStore.setState({ workspaces: { [w.id]: w }, workspaceOrder: [w.id], activeWorkspaceId: null });

    useAppStore.getState().activateWorkspace(w.id);
    // Otherwise every click on the row launches another doomed process.
    expect(start).not.toHaveBeenCalled();
  });

  it("leaves an exited runtime to the reconnect banner", () => {
    const start = stubSpawn();
    const w = createWorkspace({ harness: "omp", cwd: "/w/papers" });
    w.runtime = { id: "rt-0", harness: "omp", pid: 2, exited: true, host: null };
    useAppStore.setState({ workspaces: { [w.id]: w }, workspaceOrder: [w.id], activeWorkspaceId: null });

    useAppStore.getState().activateWorkspace(w.id);
    expect(start).not.toHaveBeenCalled();
  });

  it("does not start an agent for a terminal", () => {
    const start = stubSpawn();
    useAppStore.getState().openTerminal({ cwd: "/w/papers", program: "shell" });
    expect(start).not.toHaveBeenCalled();
  });
});
