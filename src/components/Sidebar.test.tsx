import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";
import { useAppStore } from "../lib/agent-store";
import { createWorkspace } from "../lib/store/workspace";

const cwd = "/home/abhinand/dev/g14-llm-configs";
const activePath = "/home/abhinand/.omp/agent/sessions/active.jsonl";

beforeEach(() => {
  const workspace = createWorkspace({ harness: "omp", cwd, sessionPath: activePath });
  workspace.sessionName = "Fix CUDA compilation with GCC-14";
  workspace.sessionFile = activePath;

  useAppStore.setState({
    sidebarOpen: true,
    harness: "omp",
    projects: { [cwd]: { cwd, archived: false } },
    workspaces: { [workspace.id]: workspace },
    workspaceOrder: [workspace.id],
    activeWorkspaceId: workspace.id,
    sessionFile: activePath,
    sessions: [
      {
        path: activePath,
        id: "active",
        cwd,
        timestamp: "2026-08-31T09:12:00Z",
        name: "Fix CUDA compilation with GCC-14",
        model: "glm-5.3-flash",
        version: 2,
        truncated: false,
      },
      {
        path: "/home/abhinand/.omp/agent/sessions/older.jsonl",
        id: "older",
        cwd,
        timestamp: "2026-08-30T18:40:00Z",
        name: "Older session",
        model: "claude-sonnet-4-5",
        version: 2,
        truncated: false,
      },
    ],
    target: null,
    hosts: [],
    showAddHost: false,
    providers: [],
    route: "chat",
  });
});

describe("Sidebar", () => {
  it("nests each live session under a collapsible workspace", () => {
    render(<Sidebar />);

    const toggle = screen.getByRole("button", { name: "Collapse workspace g14-llm-configs" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const group = screen.getByRole("group", { name: "Sessions in g14-llm-configs" });
    const session = screen.getByText("Fix CUDA compilation with GCC-14", { exact: true });
    expect(group).toContainElement(session);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Fix CUDA compilation with GCC-14", { exact: true })).not.toBeInTheDocument();
  });

  it("files a project's other sessions under that project, without repeating the open one", () => {
    render(<Sidebar />);

    const group = screen.getByRole("group", { name: "Sessions in g14-llm-configs" });
    // The session already open is a workspace row; it must not also appear as
    // something to reopen.
    expect(screen.getAllByText("Fix CUDA compilation with GCC-14", { exact: true })).toHaveLength(1);
    expect(group).toContainElement(screen.getByText("Older session", { exact: true }));
  });

  it("opens history as a panel rather than listing every session in the rail", () => {
    render(<Sidebar />);

    expect(useAppStore.getState().openPanel).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    expect(useAppStore.getState().openPanel).toBe("history");
  });

  it("offers a terminal in the project, as its own workspace", () => {
    render(<Sidebar />);
    const chatWorkspace = useAppStore.getState().workspaceOrder[0];

    fireEvent.click(screen.getByRole("button", { name: "New in g14-llm-configs" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /omp in a terminal/ }));

    const after = useAppStore.getState();
    const opened = after.workspaces[after.activeWorkspaceId!];
    expect(opened.kind).toBe("terminal");
    expect(opened.program).toBe("omp");
    expect(opened.cwd).toBe(cwd);
    // The chat session it was opened beside is untouched and still running.
    expect(after.workspaces[chatWorkspace].kind).toBe("chat");
  });

  it("opens a second workspace rather than resetting the running one", () => {
    render(<Sidebar />);
    const before = useAppStore.getState();
    const running = before.workspaceOrder[0];

    fireEvent.click(screen.getByRole("button", { name: "New in g14-llm-configs" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Chat session/ }));

    const after = useAppStore.getState();
    expect(after.workspaceOrder).toHaveLength(2);
    expect(after.activeWorkspaceId).not.toBe(running);
    expect(after.workspaces[running].agent).toBe(before.workspaces[running].agent);
    expect(after.workspaces[after.activeWorkspaceId!].cwd).toBe(cwd);
  });
  it("archives a whole project workspace while keeping its sessions in history", async () => {
    render(<Sidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Workspace actions for g14-llm-configs" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Archive workspace/ }));

    await waitFor(() => expect(useAppStore.getState().projects[cwd].archived).toBe(true));
    expect(useAppStore.getState().workspaceOrder).toEqual([]);
    expect(useAppStore.getState().sessions).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Restore workspace g14-llm-configs" })).toBeInTheDocument();
  });

  it("requires confirmation before deleting a project workspace", () => {
    const deleteProject = vi.fn().mockResolvedValue(undefined);
    const originalDeleteProject = useAppStore.getState().deleteProject;
    useAppStore.setState({ deleteProject });

    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace actions for g14-llm-configs" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete workspace/ }));

    expect(screen.getByText(/Sessions stay in History/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete workspace now" }));
    expect(deleteProject).toHaveBeenCalledWith(cwd);

    useAppStore.setState({ deleteProject: originalDeleteProject });
  });
});
