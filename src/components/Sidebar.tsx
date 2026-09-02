import { useMemo, useState } from "react";
import type { ReactNode } from "react";
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
  Trash2,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { SessionSummary } from "../lib/agent-state";
import { bridge } from "../lib/bridge";
import { useAppStore } from "../lib/agent-store";
import NewInProject, { type MenuAnchor } from "./NewInProject";
import { projectLabel, sessionLabel, shortAge, workspaceTitle, type Workspace } from "../lib/store/workspace";
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
  const target = useAppStore((s) => s.target);
  const hosts = useAppStore((s) => s.hosts);
  const showAddHost = useAppStore((s) => s.showAddHost);
  const setTarget = useAppStore((s) => s.setTarget);
  const setShowAddHost = useAppStore((s) => s.setShowAddHost);
  const removeHost = useAppStore((s) => s.removeHost);
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
      const project = projects[session.cwd];
      if (!project || project.archived || open.has(session.path)) continue;
      const list = out.get(session.cwd);
      if (list) list.push(session);
      else out.set(session.cwd, [session]);
    }
    for (const list of out.values()) {
      list.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    }
    return out;
  }, [sessions, projects, workspaces, order]);

  const groups = useMemo(() => {
    const out = new Map<string, Workspace[]>();
    for (const id of order) {
      const w = workspaces[id];
      if (!w || !projects[w.cwd] || projects[w.cwd].archived) continue;
      const list = out.get(w.cwd);
      if (list) list.push(w);
      else out.set(w.cwd, [w]);
    }
    for (const cwd of Object.keys(projects)) {
      if (projects[cwd].archived || out.has(cwd)) continue;
      out.set(cwd, []);
    }
    return [...out.entries()];
  }, [projects, workspaces, order]);

  const archivedProjects = useMemo(
    () =>
      Object.values(projects)
        .filter((project) => project.archived)
        .sort((a, b) => a.cwd.localeCompare(b.cwd)),
    [projects],
  );

  const chooseFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") openWorkspace({ cwd: dir });
  };

  const startScratch = async () => {
    setNewMenu(null);
    setWorkspaceMenu(null);
    await openScratchWorkspace();
    setRoute("chat");
  };

  return (
    <aside className="chrome flex w-[264px] shrink-0 flex-col border-r border-line bg-ink-1">
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

      <Section title="machine">
        <div className="flex flex-wrap gap-1">
          <MachineButton label="this machine" active={target === null} onClick={() => setTarget(null)} />
          {hosts.map((h) => (
            <span key={h.alias} className="group relative inline-flex">
              <MachineButton label={h.alias} active={target === h.alias} onClick={() => setTarget(h.alias)} />
              <button
                onClick={() => void removeHost(h.alias)}
                className="absolute -top-1 -right-1 hidden h-4 w-4 items-center justify-center rounded-full bg-red text-on-accent group-hover:flex"
                aria-label={`Remove ${h.alias}`}
              >
                <Trash2 size={8} />
              </button>
            </span>
          ))}
          <button
            onClick={() => setShowAddHost(!showAddHost)}
            className="h-control min-w-7 flex-1 rounded-sm border border-dashed border-line font-mono text-xs text-ink-faint hover:border-line-strong hover:text-ink-text"
            aria-label="Add an SSH host"
          >
            +
          </button>
        </div>
        {showAddHost ? <AddHostForm onDone={() => setShowAddHost(false)} /> : null}
        {target ? (
          <button
            onClick={() => setPanel("files")}
            className="mt-1.5 flex w-full items-center gap-2 rounded-sm border border-line bg-ink-2 px-2.5 py-1.5 text-left hover:border-line-strong"
          >
            <Server size={12} className="shrink-0 text-amber-dim" />
            <span className="flex-1 text-sm text-ink-text">Browse files on {target}</span>
          </button>
        ) : null}
      </Section>

      <div className="mt-2 flex items-center justify-between px-4 pb-1">
        <span className="font-mono text-2xs tracking-wider text-ink-faint uppercase">workspaces</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void startScratch()}
            className="rounded-sm p-1 text-ink-faint hover:bg-ink-2 hover:text-amber"
            aria-label="Start scratch session"
            title="Start a generic scratch session"
          >
            <Sparkles size={13} />
          </button>
          <button
            onClick={() => void chooseFolder()}
            className="rounded-sm p-1 text-ink-faint hover:bg-ink-2 hover:text-ink-text"
            aria-label="Open another folder"
            title="Open another folder"
          >
            <Plus size={13} />
          </button>
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
            <button
              onClick={() => void chooseFolder()}
              className="flex w-full items-center gap-2 rounded-sm border border-dashed border-line px-2.5 py-2 text-left text-sm text-ink-dim hover:border-line-strong hover:text-ink-text"
            >
              <FolderOpen size={13} className="shrink-0 text-amber-dim" />
              Open a folder to begin
            </button>
          </div>
        ) : (
          groups.map(([cwd, list]) => {
            const project = projectLabel(cwd, projects[cwd]?.kind);
            const collapsed = collapsedWorkspaces[cwd] ?? false;
            return (
              <div key={cwd} className="mb-2">
                <div className="flex items-center gap-1 px-1 pb-1">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedWorkspaces((previous) => ({
                        ...previous,
                        [cwd]: !collapsed,
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
                          setNewMenu(newMenu?.cwd === cwd ? null : { cwd, target: list[0]?.target ?? null });
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
                          setWorkspaceMenu(workspaceMenu === cwd ? null : cwd);
                        }}
                        aria-haspopup="menu"
                        aria-expanded={workspaceMenu === cwd}
                        className="rounded-sm p-1 text-ink-faint hover:bg-ink-2 hover:text-ink-text"
                        aria-label={`Workspace actions for ${project}`}
                        title={`Workspace actions for ${project}`}
                      >
                        <MoreHorizontal size={13} />
                      </button>
                      {workspaceMenu === cwd ? (
                        <WorkspaceActionsMenu cwd={cwd} onClose={() => setWorkspaceMenu(null)} />
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
                      sessions={sessionsByProject.get(cwd) ?? []}
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
            <div className="px-1 pb-1 font-mono text-2xs tracking-wider text-ink-faint uppercase">archived</div>
            {archivedProjects.map(({ cwd }) => {
              const project = projectLabel(cwd, projects[cwd]?.kind);
              return (
                <div key={cwd} className="group flex items-center gap-1 rounded-sm px-1 py-1">
                  <button
                    type="button"
                    onClick={() => restoreProject(cwd)}
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
                        setWorkspaceMenu(workspaceMenu === cwd ? null : cwd);
                      }}
                      aria-haspopup="menu"
                      aria-expanded={workspaceMenu === cwd}
                      aria-label={`Workspace actions for ${project}`}
                      title={`Workspace actions for ${project}`}
                      className="row-actions rounded-sm p-1 text-ink-faint hover:bg-ink-2 hover:text-ink-text"
                    >
                      <MoreHorizontal size={13} />
                    </button>
                    {workspaceMenu === cwd ? (
                      <WorkspaceActionsMenu cwd={cwd} onClose={() => setWorkspaceMenu(null)} />
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

  return (
    <div
      className={`group flex items-center gap-1.5 rounded-sm px-2 py-1.5 ${
        active ? "bg-ink-3" : "hover:bg-ink-2"
      }`}
    >
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

function MachineButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`h-control min-w-14 flex-1 rounded-sm border px-2 font-mono text-xs ${
        active ? "border-teal/60 bg-teal/10 text-teal" : "border-line text-ink-faint hover:text-ink-dim"
      }`}
    >
      {label}
    </button>
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


function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-3 pt-2 pb-1">
      <div className="px-1 pb-1.5 font-mono text-2xs tracking-wider text-ink-faint uppercase">{title}</div>
      {children}
    </div>
  );
}
