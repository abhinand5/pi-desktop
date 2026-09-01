import { beforeEach, describe, expect, it } from "vitest";
import { loadWorkspaces, saveWorkspaces } from "./persist";
import { createWorkspace, type Workspace } from "./workspace";

function installLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => void values.set(k, v),
      removeItem: (k: string) => void values.delete(k),
    } as unknown as Storage,
  });
}

function state(workspaces: Workspace[], activeIndex = 0) {
  return {
    projects: Object.fromEntries(workspaces.map((w) => [w.cwd, { cwd: w.cwd, archived: false }])),
    workspaces: Object.fromEntries(workspaces.map((w) => [w.id, w])),
    workspaceOrder: workspaces.map((w) => w.id),
    activeWorkspaceId: workspaces[activeIndex]?.id ?? null,
  };
}

describe("remembered workspaces", () => {
  beforeEach(installLocalStorage);

  it("brings back the folder, agent, machine, and session, and which one was in front", () => {
    const a = createWorkspace({ harness: "omp", cwd: "/home/me/papers" });
    a.sessionFile = "/home/me/.omp/agent/sessions/a.jsonl";
    a.sessionName = "Read the GDN paper";
    const b = createWorkspace({ harness: "pi", cwd: "/home/me/pi-desktop", target: "build-box" });

    saveWorkspaces(state([a, b], 1));
    const restored = loadWorkspaces()!;

    const order = restored.workspaceOrder.map((id) => restored.workspaces[id]);
    expect(order.map((w) => w.cwd)).toEqual(["/home/me/papers", "/home/me/pi-desktop"]);
    expect(order[0].sessionName).toBe("Read the GDN paper");
    expect(order[0].selectedSessionPath).toBe("/home/me/.omp/agent/sessions/a.jsonl");
    expect(order[1].harness).toBe("pi");
    expect(order[1].target).toBe("build-box");
    expect(restored.activeWorkspaceId).toBe(order[1].id);
  });

  it("remembers an archived project with no open session tabs", () => {
    const archived = { cwd: "/home/me/old-project", archived: true };

    saveWorkspaces({
      projects: { [archived.cwd]: archived },
      workspaces: {},
      workspaceOrder: [],
      activeWorkspaceId: null,
    });

    expect(loadWorkspaces()).toMatchObject({ projects: { [archived.cwd]: archived } });
  });

  it("comes back idle — a stored runtime would point at a process that is gone", () => {
    const w = createWorkspace({ harness: "omp", cwd: "/home/me/papers" });
    w.runtime = { id: "rt-1", pid: 4242, exited: false } as Workspace["runtime"];
    w.agent = { ...w.agent, entries: [{ kind: "user", seq: 1, text: "hello" }] };

    saveWorkspaces(state([w]));
    const back = Object.values(loadWorkspaces()!.workspaces)[0];

    expect(back.runtime).toBeNull();
    expect(back.agent.entries).toEqual([]);
  });

  it("returns nothing rather than a broken workspace when the store is junk", () => {
    window.localStorage.setItem("pi-desktop.workspaces", "{not json");
    expect(loadWorkspaces()).toBeNull();

    // A folderless or unknown-harness entry is dropped, not restored blank.
    window.localStorage.setItem(
      "pi-desktop.workspaces",
      JSON.stringify({ version: 1, active: 0, workspaces: [{ cwd: "", harness: "omp" }, { cwd: "/x", harness: "zsh" }] }),
    );
    expect(loadWorkspaces()).toBeNull();
  });
});
