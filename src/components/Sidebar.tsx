import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  BarChart3,
  Circle,
  FolderOpen,
  Loader2,
  Plug,
  Plus,
  RotateCw,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { SessionSummary } from "../lib/agent-state";
import { bridge } from "../lib/bridge";
import { useAppStore } from "../lib/agent-store";
import { projectName, workspaceTitle, type Workspace } from "../lib/store/workspace";

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
  const refreshSessions = useAppStore((s) => s.refreshSessions);
  const resumeSession = useAppStore((s) => s.resumeSession);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const sessionFile = useAppStore((s) => s.sessionFile);

  const groups = useMemo(() => {
    const out = new Map<string, Workspace[]>();
    for (const id of order) {
      const w = workspaces[id];
      if (!w) continue;
      const key = w.cwd || "no folder";
      const list = out.get(key);
      if (list) list.push(w);
      else out.set(key, [w]);
    }
    return [...out.entries()];
  }, [workspaces, order]);

  const chooseFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") openWorkspace({ cwd: dir });
  };

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-ink-1">
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
                className="absolute -top-1 -right-1 hidden h-4 w-4 items-center justify-center rounded-full bg-red text-ink-0 group-hover:flex"
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
        <button
          onClick={() => void chooseFolder()}
          className="text-ink-faint hover:text-ink-text"
          aria-label="Open another folder"
          title="Open another folder"
        >
          <Plus size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {groups.length === 0 ? (
          <button
            onClick={() => void chooseFolder()}
            className="flex w-full items-center gap-2 rounded-sm border border-dashed border-line px-2.5 py-2 text-left text-sm text-ink-dim hover:border-line-strong hover:text-ink-text"
          >
            <FolderOpen size={13} className="shrink-0 text-amber-dim" />
            Open a folder to begin
          </button>
        ) : (
          groups.map(([cwd, list]) => (
            <div key={cwd} className="mb-2">
              <div className="px-1 pb-0.5 font-mono text-2xs text-ink-faint" title={cwd}>
                {projectName(cwd)}
              </div>
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
            </div>
          ))
        )}

        <div className="mt-1 flex items-center justify-between px-1 pb-1">
          <span className="font-mono text-2xs tracking-wider text-ink-faint uppercase">history</span>
          <button
            onClick={() => void refreshSessions()}
            className="text-ink-faint hover:text-ink-dim"
            aria-label="Reload sessions"
          >
            <RotateCw size={11} />
          </button>
        </div>
        {sessions.length === 0 ? (
          <p className="px-1 text-sm text-ink-faint">
            Past sessions are {harness}'s own files, read from{" "}
            {harness === "pi" ? "~/.pi/agent" : "~/.omp/agent"}.
          </p>
        ) : (
          [...sessions]
            .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
            .slice(0, 30)
            .map((s) => (
              <SessionRow
                key={s.id + s.path}
                session={s}
                current={s.path === sessionFile}
                onResume={() => void resumeSession(s)}
                onDelete={() => void deleteSession(s.path)}
              />
            ))
        )}
      </div>

      <div className="shrink-0 border-t border-line p-2">
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
  const live = !!workspace.runtime && !workspace.runtime.exited;
  const working = live && workspace.agent.streaming;

  return (
    <div
      className={`group flex items-center gap-1.5 rounded-sm px-2 py-1.5 ${
        active ? "bg-ink-3" : "hover:bg-ink-2"
      }`}
    >
      <StateDot working={working} live={live} unread={workspace.unread} connecting={workspace.connecting} />
      <button onClick={onSelect} className="min-w-0 flex-1 truncate text-left text-sm text-ink-text">
        {workspaceTitle(workspace)}
      </button>
      {workspace.target ? (
        <span className="shrink-0 font-mono text-2xs text-teal">{workspace.target}</span>
      ) : null}
      <button
        onClick={onClose}
        aria-label={`Close ${workspaceTitle(workspace)}`}
        className="row-actions shrink-0 text-ink-faint hover:text-red"
      >
        <X size={11} />
      </button>
    </div>
  );
}

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
        <button onClick={() => void submit()} className="h-control-sm flex-1 rounded-sm bg-amber font-mono text-2xs text-ink-0">
          save
        </button>
      </div>
      <p className="text-2xs text-ink-faint">
        Key auth only. The agent must already be installed on the host, or bootstrapped from here.
      </p>
    </div>
  );
}

function SessionRow({
  session,
  current,
  onResume,
  onDelete,
}: {
  session: SessionSummary;
  current: boolean;
  onResume: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const time = session.timestamp?.slice(0, 16).replace("T", " ") ?? "";

  return (
    <div
      className={`group flex items-center gap-1 rounded-sm px-1.5 py-1.5 ${current ? "bg-ink-2" : "hover:bg-ink-2/60"}`}
    >
      <button onClick={onResume} className="min-w-0 flex-1 text-left" title={`${session.cwd}\n${session.path}`}>
        <span className="truncate text-sm text-ink-dim">{session.name ?? session.id.slice(0, 12)}</span>
        <span className="mt-0.5 flex items-baseline gap-1.5 font-mono text-2xs text-ink-faint">
          <span className="shrink-0 whitespace-nowrap">{time}</span>
          {session.model ? <span className="min-w-0 truncate">{session.model}</span> : null}
        </span>
      </button>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1">
          <button onClick={onDelete} className="font-mono text-2xs text-red hover:underline">
            delete
          </button>
          <button onClick={() => setConfirming(false)} className="font-mono text-2xs text-ink-faint hover:text-ink-dim">
            keep
          </button>
        </span>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${session.name ?? session.id}`}
          className="row-actions shrink-0 text-ink-faint hover:text-red"
        >
          <Trash2 size={11} />
        </button>
      )}
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
