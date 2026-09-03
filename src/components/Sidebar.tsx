import { useMemo, useState } from "react";
import {
  Archive,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Circle,
  FolderOpen,
  History as HistoryIcon,
  Loader2,
  MoreHorizontal,
  Plug,
  Plus,
  Server,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { SessionSummary } from "../lib/agent-state";
import { bridge } from "../lib/bridge";
import { formatCost } from "../lib/format";
import { useAppStore } from "../lib/agent-store";
import NewInProject, { type MenuAnchor } from "./NewInProject";
import { projectKey, projectLabel, sessionLabel, shortAge, workspaceTitle, type Workspace } from "../lib/store/workspace";
import MachineSwitcher from "./MachineSwitcher";
import WorkspaceActionsMenu from "./WorkspaceActionsMenu";

/**
 * The left rail: your open workspaces, grouped by project.
 *
 * A workspace keeps running when you switch away from it, so this list is the
 * app's real navigation — the dot on a row says whether that agent is working,
 * idle, or has finished something you have not looked at yet.
 */
export default function Sidebar() {
  const openState = useAppStore((s) => s.sidebarOpen);
  if (!openState) return null;
  return <SidebarBody />;
}

function SidebarBody() {
  const harness = useAppStore((s) => s.harness);
  const projects = useAppStore((s) => s.projects);
  const workspaces = useAppStore((s) => s.workspaces);
  const order = useAppStore((s) => s.workspaceOrder);
  const activeId = useAppStore((s) => s.activeWorkspaceId);
  const activateWorkspace = useAppStore((s) => s.activateWorkspace);
  const closeWorkspace = useAppStore((s) => s.closeWorkspace);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const sessions = useAppStore((s) => s.sessions);
  const providers = useAppStore((s) => s.providers);
  const setPanel = useAppStore((s) => s.setPanel);
  const setRoute = useAppStore((s) => s.setRoute);
  const route = useAppStore((s) => s.route);
  const activeMachine = useAppStore((s) => s.activeMachine);
  const showAddHost = useAppStore((s) => s.showAddHost);
  const setShowAddHost = useAppStore((s) => s.setShowAddHost);
  const setHarness = useAppStore((s) => s.setHarness);
  const resumeSession = useAppStore((s) => s.resumeSession);
  const restoreProject = useAppStore((s) => s.restoreProject);
  const openScratchWorkspace = useAppStore((s) => s.openScratchWorkspace);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Record<string, boolean>>({});
  const [newMenu, setNewMenu] = useState<MenuAnchor | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState<string | null>(null);

  const sessionsByProject = useMemo(() => {
    const open = new Set<string>();
    for (const id of order) {
      const w = workspaces[id];
      if (w?.sessionFile) open.add(w.sessionFile);
      if (w?.selectedSessionPath) open.add(w.selectedSessionPath);
    }
    const out = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      // `sessions_list` scans this machine's disk, so every session it returns
      // belongs to a local project.
      const key = projectKey(null, session.cwd);
      const project = projects[key];
      if (!project || project.archived || open.has(session.path)) continue;
      const list = out.get(key);
      if (list) list.push(session);
      else out.set(key, [session]);
    }
    for (const list of out.values()) {
      list.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    }
    return out;
  }, [sessions, projects, workspaces, order]);

  // Only the machine you are on. The others keep their workspaces, their
  // runtimes, and their place in the order — they are simply not this desktop.
  const groups = useMemo(() => {
    const out = new Map<string, Workspace[]>();
    for (const id of order) {
      const w = workspaces[id];
      if (!w || w.target !== activeMachine) continue;
      const key = projectKey(w.target, w.cwd);
      if (!projects[key] || projects[key].archived) continue;
      const list = out.get(key);
      if (list) list.push(w);
      else out.set(key, [w]);
    }
    for (const [key, p] of Object.entries(projects)) {
      if (p.archived || p.target !== activeMachine || out.has(key)) continue;
      out.set(key, []);
    }
    return [...out.entries()];
  }, [projects, workspaces, order, activeMachine]);

  const archivedProjects = useMemo(
    () =>
      Object.entries(projects)
        .filter(([, project]) => project.archived && project.target === activeMachine)
        .sort(([, a], [, b]) => a.cwd.localeCompare(b.cwd)),
    [projects, activeMachine],
  );

  const chooseFolder = async () => {
    // The picker browses this machine's disk, so it is only offered here; a
    // remote folder is reached through the file browser instead.
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") openWorkspace({ cwd: dir, target: null });
  };

  const startScratch = async () => {
    setNewMenu(null);
    setWorkspaceMenu(null);
    await openScratchWorkspace();
    setRoute("chat");
  };

  return (
    <aside className="chrome flex w-[264px] shrink-0 flex-col border-r border-line bg-ink-1 max-[1080px]:w-[212px]">
      <div className="flex gap-1 px-3 pt-3 pb-1">
        {(["pi", "omp"] as const).map((h) => (
          <button
            key={h}
            onClick={() => setHarness(h)}
            aria-pressed={harness === h}
            className={`h-control flex-1 rounded-sm border font-mono text-xs tracking-wide ${
              harness === h
                ? "border-amber-dim/60 bg-amber/15 text-amber"
                : "border-line text-ink-faint hover:text-ink-dim"
            }`}
          >
            {h}
          </button>
        ))}
      </div>

      <MachineSwitcher />
      {showAddHost ? (
        <div className="px-3 pt-2">
          <AddHostForm onDone={() => setShowAddHost(false)} />
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-between px-4 pb-1">
        <span className="eyebrow font-mono text-2xs tracking-wider text-ink-faint uppercase">workspaces</span>
        <div className="flex items-center gap-1">
          {/* The first host has to be reachable before there is a switcher to
              reach it from — the switcher hides itself until one exists. */}
          <button
            onClick={() => setShowAddHost(!showAddHost)}
            className="rounded-sm p-1 text-ink-faint hover:bg-ink-2 hover:text-teal"
            aria-label="Connect to a machine"
            title="Connect to a machine over SSH"
          >
            <Server size={13} />
          </button>
          <button
            onClick={() => void startScratch()}
            className="rounded-sm p-1 text-ink-faint hover:bg-ink-2 hover:text-amber"
            aria-label="Start scratch session"
            title="Start a generic scratch session"
          >
            <Sparkles size={13} />
          </button>
          {activeMachine ? (
            <button
              onClick={() => setPanel("files")}
              className="rounded-sm p-1 text-ink-faint hover:bg-ink-2 hover:text-ink-text"
              aria-label={`Open a folder on ${activeMachine}`}
              title={`Open a folder on ${activeMachine}`}
            >
              <Plus size={13} />
            </button>
          ) : (
            <button
              onClick={() => void chooseFolder()}
              className="rounded-sm p-1 text-ink-faint hover:bg-ink-2 hover:text-ink-text"
              aria-label="Open another folder"
              title="Open another folder"
            >
              <Plus size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {groups.length === 0 && archivedProjects.length === 0 ? (
          <div className="space-y-1">
            <button
              onClick={() => void startScratch()}
              className="flex w-full items-center gap-2 rounded-sm border border-amber-dim/40 bg-amber/5 px-2.5 py-2 text-left text-sm text-amber hover:bg-amber/10"
            >
              <Sparkles size={13} className="shrink-0" />
              Start a scratch session
            </button>
            {activeMachine ? (
              <button
                onClick={() => setPanel("files")}
                className="flex w-full items-center gap-2 rounded-sm border border-dashed border-line px-2.5 py-2 text-left text-sm text-ink-dim hover:border-line-strong hover:text-ink-text"
              >
                <Server size={13} className="shrink-0 text-teal" />
                Open a folder on {activeMachine}
              </button>
            ) : (
              <button
                onClick={() => void chooseFolder()}
                className="flex w-full items-center gap-2 rounded-sm border border-dashed border-line px-2.5 py-2 text-left text-sm text-ink-dim hover:border-line-strong hover:text-ink-text"
              >
                <FolderOpen size={13} className="shrink-0 text-amber-dim" />
                Open a folder to begin
              </button>
            )}
          </div>
        ) : (
          groups.map(([key, list]) => {
            const cwd = projects[key]?.cwd ?? "";
            const project = projectLabel(cwd, projects[key]?.kind);
            const collapsed = collapsedWorkspaces[key] ?? false;
            return (
              <div key={key} className="mb-2">
                <div className="flex items-center gap-1 px-1 pb-1">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedWorkspaces((previous) => ({
                        ...previous,
                        [key]: !collapsed,
                      }))
                    }
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? "Expand" : "Collapse"} workspace ${project}`}
                    title={cwd}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 text-left hover:bg-ink-2"
                  >
                    {collapsed ? (
                      <ChevronRight size={12} className="shrink-0 text-ink-faint" />
                    ) : (
                      <ChevronDown size={12} className="shrink-0 text-ink-faint" />
                    )}
                    {projects[cwd]?.kind === "scratch" ? <Sparkles size={11} className="shrink-0 text-amber" /> : null}
                    <span className="truncate text-sm text-ink-text">{project}</span>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          setWorkspaceMenu(null);
                          setNewMenu(
                            newMenu?.cwd === cwd ? null : { cwd, target: projects[key]?.target ?? null },
                          );
                        }}
                        aria-haspopup="menu"
                        aria-expanded={newMenu?.cwd === cwd}
                        className="rounded-sm p-1 text-ink-faint hover:bg-ink-2 hover:text-ink-text"
                        aria-label={`New in ${project}`}
                        title={`New in ${project}`}
                      >
                        <Plus size={13} />
                      </button>
                      {newMenu?.cwd === cwd ? (
                        <NewInProject anchor={newMenu} onClose={() => setNewMenu(null)} />
                      ) : null}
                    </div>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          setNewMenu(null);
                          setWorkspaceMenu(workspaceMenu === key ? null : key);
                        }}
                        aria-haspopup="menu"
                        aria-expanded={workspaceMenu === key}
                        className="rounded-sm p-1 text-ink-faint hover:bg-ink-2 hover:text-ink-text"
                        aria-label={`Workspace actions for ${project}`}
                        title={`Workspace actions for ${project}`}
                      >
                        <MoreHorizontal size={13} />
                      </button>
                      {workspaceMenu === key ? (
                        <WorkspaceActionsMenu projectKey={key} onClose={() => setWorkspaceMenu(null)} />
                      ) : null}
                    </div>
                  </div>
                </div>
                {!collapsed ? (
                  <div
                    role="group"
                    aria-label={`Sessions in ${project}`}
                    className="ml-3 border-l border-line/60 pl-2"
                  >
                    {list.map((w) => (
                      <WorkspaceRow
                        key={w.id}
                        workspace={w}
                        active={w.id === activeId && route === "chat"}
                        onSelect={() => {
                          activateWorkspace(w.id);
                          setRoute("chat");
                        }}
                        onClose={() => void closeWorkspace(w.id)}
                      />
                    ))}
                    <ProjectSessions
                      sessions={sessionsByProject.get(key) ?? []}
                      onOpen={(s) => void resumeSession(s)}
                      onSeeAll={() => setPanel("history")}
                    />
                  </div>
                ) : null}
              </div>
            );
          })
        )}
        {archivedProjects.length ? (
          <div className="mt-4 border-t border-line/60 pt-2">
            <div className="eyebrow px-1 pb-1 font-mono text-2xs tracking-wider text-ink-faint uppercase">archived</div>
            {archivedProjects.map(([key, saved]) => {
              const cwd = saved.cwd;
              const project = projectLabel(cwd, saved.kind);
              return (
                <div key={key} className="group flex items-center gap-1 rounded-sm px-1 py-1">
                  <button
                    type="button"
                    onClick={() => restoreProject(key)}
                    aria-label={`Restore workspace ${project}`}
                    title={cwd}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-sm text-ink-dim hover:bg-ink-2 hover:text-ink-text"
                  >
                    <Archive size={12} className="shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1 truncate">{project}</span>
                  </button>
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setNewMenu(null);
                        setWorkspaceMenu(workspaceMenu === key ? null : key);
                      }}
                      aria-haspopup="menu"
                      aria-expanded={workspaceMenu === key}
                      aria-label={`Workspace actions for ${project}`}
                      title={`Workspace actions for ${project}`}
                      className="row-actions rounded-sm p-1 text-ink-faint hover:bg-ink-2 hover:text-ink-text"
                    >
                      <MoreHorizontal size={13} />
                    </button>
                    {workspaceMenu === key ? (
                      <WorkspaceActionsMenu projectKey={key} onClose={() => setWorkspaceMenu(null)} />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

      </div>

      <div className="shrink-0 border-t border-line p-2">
        <button
          onClick={() => setPanel("history")}
          className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm text-ink-dim hover:bg-ink-2 hover:text-ink-text"
        >
          <HistoryIcon size={13} className="shrink-0" />
          <span className="flex-1">History</span>
          <span className="font-mono text-2xs text-ink-faint">{sessions.length}</span>
        </button>
        <button
          onClick={() => setRoute("usage")}
          aria-pressed={route === "usage"}
          className={`flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm ${
            route === "usage" ? "bg-ink-3 text-ink-text" : "text-ink-dim hover:bg-ink-2 hover:text-ink-text"
          }`}
        >
          <BarChart3 size={13} className="shrink-0" />
          Usage
        </button>
        <button
          onClick={() => setPanel("providers")}
          className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm text-ink-dim hover:bg-ink-2 hover:text-ink-text"
        >
          <Plug size={13} className="shrink-0" />
          <span className="flex-1">Endpoints &amp; models</span>
          <span className="font-mono text-2xs text-ink-faint">{providers.length}</span>
        </button>
      </div>
    </aside>
  );
}

/** How many of a project's past sessions the rail shows before deferring to
 *  the history panel. Enough to recognize last week; not a second history. */
const SESSIONS_PER_PROJECT = 4;

/** A project's past conversations, under its open ones. */
function ProjectSessions({
  sessions,
  onOpen,
  onSeeAll,
}: {
  sessions: SessionSummary[];
  onOpen: (session: SessionSummary) => void;
  onSeeAll: () => void;
}) {
  const shown = sessions.slice(0, SESSIONS_PER_PROJECT);
  const rest = sessions.length - shown.length;

  return (
    <>
      {shown.map((s) => (
        <button
          key={s.id + s.path}
          onClick={() => onOpen(s)}
          title={`${s.name ?? s.id}\n${s.path}`}
          className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left hover:bg-ink-2"
        >
          <Circle size={7} className="shrink-0 text-ink-faint/40" aria-label="not open" />
          <span className="min-w-0 flex-1 truncate text-sm text-ink-dim">{sessionLabel(s)}</span>
          <span className="shrink-0 font-mono text-2xs text-ink-faint">{shortAge(s.timestamp)}</span>
        </button>
      ))}
      {rest > 0 ? (
        <button
          onClick={onSeeAll}
          className="w-full px-2 py-1 text-left font-mono text-2xs text-ink-faint hover:text-ink-dim"
        >
          {rest} more in history
        </button>
      ) : null}
    </>
  );
}

function WorkspaceRow({
  workspace,
  active,
  onSelect,
  onClose,
}: {
  workspace: Workspace;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const terminal = workspace.kind === "terminal";
  const live = !!workspace.runtime && !workspace.runtime.exited;
  const working = live && workspace.agent.streaming;
  const label = terminal ? TERMINAL_TITLE[workspace.program] : workspaceTitle(workspace);

  // What this session has cost so far, and how full its window is. The rail is
  // where you watch work you are not looking at, so the two numbers you would
  // otherwise have to open the session to see belong on the row.
  const cost = workspace.stats?.cost;
  const context = workspace.context?.percent;
  const status = working ? "working" : workspace.connecting ? "starting" : null;

  return (
    <div
      data-row
      className={`group rounded-sm px-2 py-1.5 ${active ? "bg-ink-3" : "hover:bg-ink-2"}`}
    >
      <div className="flex items-center gap-1.5">
        {terminal ? (
          <SquareTerminal size={11} className="shrink-0 text-ink-faint" aria-label="terminal" />
        ) : (
          <StateDot working={working} live={live} unread={workspace.unread} connecting={workspace.connecting} />
        )}
        <button onClick={onSelect} className="min-w-0 flex-1 truncate text-left text-sm text-ink-text">
          {label}
        </button>
        {workspace.target ? (
          <span className="shrink-0 font-mono text-2xs text-teal">{workspace.target}</span>
        ) : null}
        <button
          onClick={onClose}
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
          className="row-actions shrink-0 text-ink-faint hover:text-red"
        >
          <X size={11} />
        </button>
      </div>

      {/* A second line, only where the skin has the room for it and only when
          there is something on it worth the height. */}
      {!terminal && (status || cost || context !== undefined) ? (
        <div className="row-status mt-0.5 ml-[18px] flex items-center gap-2 font-mono text-2xs tabular-nums text-ink-faint">
          {status ? <span className="text-amber">{status}</span> : null}
          {cost ? <span>{formatCost(cost)}</span> : null}
          {context !== undefined ? <span>{Math.round(context)}% ctx</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A terminal has no session name to show, so it says what it runs. */
const TERMINAL_TITLE: Record<string, string> = {
  shell: "terminal",
  pi: "pi · terminal",
  omp: "omp · terminal",
};

/** Working, idle, or finished-while-you-were-away. */
function StateDot({
  working,
  live,
  unread,
  connecting,
}: {
  working: boolean;
  live: boolean;
  unread: boolean;
  connecting: boolean;
}) {
  if (connecting) {
    return <Loader2 size={9} className="shrink-0 animate-spin text-ink-faint" aria-label="starting" />;
  }
  if (working) {
    return <span className="spine-running h-[7px] w-[7px] shrink-0 rounded-full bg-amber" aria-label="working" />;
  }
  if (unread) {
    return <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-green" aria-label="finished" />;
  }
  return (
    <Circle
      size={7}
      className={`shrink-0 ${live ? "text-ink-dim" : "text-ink-faint/50"}`}
      aria-label={live ? "idle" : "stopped"}
    />
  );
}


function AddHostForm({ onDone }: { onDone: () => void }) {
  const addHost = useAppStore((s) => s.addHost);
  const [alias, setAlias] = useState("");
  const [destination, setDestination] = useState("");
  const [port, setPort] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);

  const field =
    "w-full rounded-sm border border-line bg-ink-2 px-2 py-1 font-mono text-xs text-ink-text placeholder:text-ink-faint focus:border-amber-dim";

  const submit = async () => {
    setError(null);
    if (!alias.trim() || !destination.trim()) {
      setError("An alias and a user@host are both required.");
      return;
    }
    try {
      await addHost(alias.trim(), destination.trim(), port ? Number(port) : null);
      onDone();
    } catch (e) {
      setError(String(e));
    }
  };

  const test = async () => {
    setProbe("checking…");
    try {
      const result = await bridge.sshHostTest(destination.trim(), port ? Number(port) : null);
      setProbe(result.reachable ? "reachable" : result.detail);
    } catch (e) {
      setProbe(String(e).slice(0, 120));
    }
  };

  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-line bg-ink-0 p-2">
      <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="alias (gpu)" className={field} />
      <input
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
        placeholder="user@host"
        className={field}
      />
      <input
        value={port}
        onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
        placeholder="port (22)"
        className={field}
      />
      {error ? <div className="font-mono text-2xs text-red">{error}</div> : null}
      {probe ? (
        <div className={`font-mono text-2xs ${probe === "reachable" ? "text-green" : "text-ink-dim"}`}>{probe}</div>
      ) : null}
      <div className="flex gap-1.5">
        <button
          onClick={() => void test()}
          disabled={!destination.trim()}
          className="h-control-sm flex-1 rounded-sm border border-line font-mono text-2xs text-teal disabled:opacity-40"
        >
          test
        </button>
        <button onClick={onDone} className="h-control-sm rounded-sm px-2 font-mono text-2xs text-ink-faint hover:text-ink-dim">
          cancel
        </button>
        <button onClick={() => void submit()} className="h-control-sm flex-1 rounded-sm bg-amber font-mono text-2xs text-on-accent">
          save
        </button>
      </div>
      <p className="text-2xs text-ink-faint">
        Key auth only. The agent must already be installed on the host, or bootstrapped from here.
      </p>
    </div>
  );
}


