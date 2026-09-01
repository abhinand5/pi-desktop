import { useEffect, useMemo, useState, type ReactNode } from "react";
import { GitBranch, Maximize2, Minus, PanelLeft, Settings, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { useAppStore } from "../lib/agent-store";

/**
 * Window chrome and live session identity.
 *
 * The window is undecorated, so the controls are ours to draw on every
 * platform — drawing them only on Windows left Linux with no way to close the
 * window at all. macOS is the exception: its traffic lights float over the
 * webview, so we leave room for them instead of drawing our own.
 */
export default function Titlebar() {
  const cwd = useAppStore((s) => s.cwd);
  const runtime = useAppStore((s) => s.runtime);
  const connecting = useAppStore((s) => s.connecting);
  const streaming = useAppStore((s) => s.agent.streaming);
  const sessionName = useAppStore((s) => s.sessionName);
  const tree = useAppStore((s) => s.tree);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const treeOpen = useAppStore((s) => s.openPanel === "tree");
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setRoute = useAppStore((s) => s.setRoute);
  const route = useAppStore((s) => s.route);
  const kind = useAppStore((s) => s.kind);
  const program = useAppStore((s) => s.program);

  const [os, setOs] = useState<string | null>(null);
  useEffect(() => {
    try {
      setOs(platform());
    } catch {
      // Outside the Tauri webview (tests, browser preview) there is no host OS.
      setOs(null);
    }
  }, []);

  const isMac = os === "macos";
  const project = cwd ? (cwd.split("/").filter(Boolean).pop() ?? cwd) : "no project";
  const terminal = kind === "terminal";
  // A terminal has no agent to be starting, idle, or working, so it says what
  // it is instead of borrowing a state that does not apply to it.
  const state = terminal
    ? program === "shell"
      ? "shell"
      : program
    : connecting
      ? "starting"
      : runtime === null
        ? "idle"
        : runtime.exited
          ? "exited"
          : streaming
            ? "working"
            : "ready";
  const branches = countBranches(tree?.nodes ?? []);

  return (
    <header
      data-tauri-drag-region
      className={`chrome flex h-11 shrink-0 items-center gap-2 border-b border-line bg-ink-1 select-none ${
        isMac ? "pl-[78px]" : "pl-2"
      }`}
    >
      <button
        onClick={toggleSidebar}
        aria-label={sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}
        aria-pressed={sidebarOpen}
        title="Toggle the sidebar (⌘B)"
        className="flex h-control w-control shrink-0 items-center justify-center rounded-sm text-ink-faint hover:bg-ink-2 hover:text-ink-text"
      >
        <PanelLeft size={14} />
      </button>

      <span className="font-mono text-sm tracking-wide text-amber select-none">π</span>

      <span className="flex min-w-0 flex-1 items-baseline gap-2" title={cwd ?? undefined}>
        <span className="truncate font-mono text-xs text-ink-text">
          {terminal ? project : sessionName || project}
        </span>
        <StatusDot state={state} />
        <span className="font-mono text-2xs text-ink-faint">{state}</span>
      </span>

      {branches > 0 && !terminal ? (
        <button
          onClick={() => togglePanel("tree")}
          aria-pressed={treeOpen}
          title="Conversation tree (⌘T)"
          className={`flex h-control shrink-0 items-center gap-1.5 rounded-sm border px-2 font-mono text-2xs ${
            treeOpen ? "border-amber-dim bg-amber/10 text-amber" : "border-line text-ink-dim hover:border-line-strong"
          }`}
        >
          <GitBranch size={11} />
          {branches} {branches === 1 ? "branch" : "branches"}
        </button>
      ) : null}

      <button
        onClick={() => setRoute(route === "settings" ? "chat" : "settings")}
        aria-pressed={route === "settings"}
        aria-label="Settings"
        title="Settings (⌘,)"
        className={`flex h-control w-control shrink-0 items-center justify-center rounded-sm ${
          route === "settings" ? "bg-ink-3 text-ink-text" : "text-ink-faint hover:bg-ink-2 hover:text-ink-text"
        }`}
      >
        <Settings size={14} />
      </button>

      {isMac ? <div className="w-2" /> : <WindowControls />}
    </header>
  );
}

function StatusDot({ state }: { state: string }) {
  const tone =
    state === "working"
      ? "bg-amber"
      : state === "ready"
        ? "bg-green"
        : state === "exited"
          ? "bg-red"
          : "bg-ink-faint";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} aria-hidden />;
}

/** Points in the session that were answered more than one way. */
function countBranches(nodes: { id: string; parentId: string | null }[]): number {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = n.parentId ?? "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].filter((c) => c > 1).length;
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  // Resolved lazily and defensively: the window API is absent outside a real
  // webview, and losing it must not take the whole title bar down with it.
  const appWindow = useMemo(() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    // Guarded: outside a real webview these APIs are absent, and the controls
    // still need to render rather than taking the whole app down.
    if (!appWindow) return;
    const read = () => void appWindow.isMaximized?.().then(setMaximized).catch(() => {});
    read();
    const unlisten = appWindow.onResized?.(read);
    return () => {
      void Promise.resolve(unlisten)
        .then((off) => typeof off === "function" && off())
        .catch(() => {});
    };
  }, [appWindow]);

  return (
    <div className="flex h-full shrink-0">
      <WindowButton onClick={() => void appWindow?.minimize()} label="Minimize">
        <Minus size={14} />
      </WindowButton>
      <WindowButton
        onClick={() => void appWindow?.toggleMaximize()}
        label={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? <RestoreGlyph /> : <Maximize2 size={11} />}
      </WindowButton>
      <WindowButton onClick={() => void appWindow?.close()} label="Close" danger>
        <X size={15} />
      </WindowButton>
    </div>
  );
}

/** Two offset squares — the conventional "restore down" mark. */
function RestoreGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="0.65" y="2.65" width="7.7" height="7.7" rx="1.2" />
      <path d="M3.2 2.4V1.85A1.2 1.2 0 0 1 4.4.65h5A1.2 1.2 0 0 1 10.6 1.85v5a1.2 1.2 0 0 1-1.2 1.2h-.55" />
    </svg>
  );
}

function WindowButton({
  children,
  onClick,
  label,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-full w-11 items-center justify-center text-ink-dim ${
        danger ? "hover:bg-red hover:text-white" : "hover:bg-ink-3 hover:text-ink-text"
      }`}
    >
      {children}
    </button>
  );
}
