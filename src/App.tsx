import { useEffect } from "react";
import { Sparkles } from "lucide-react";
import Sidebar from "./components/Sidebar";
import Titlebar from "./components/Titlebar";
import Transcript from "./components/Transcript";
import TerminalView from "./components/TerminalView";
import Composer from "./components/Composer";
import ReconnectBanner from "./components/ReconnectBanner";
import ProvidersPanel from "./components/ProvidersPanel";
import FilesPanel from "./components/FilesPanel";
import CommandPalette from "./components/CommandPalette";
import HistoryPanel from "./components/HistoryPanel";
import TreeRail from "./components/TreeRail";
import StatusPanel from "./components/StatusPanel";
import TerminalPanel from "./components/TerminalPanel";
import SettingsPage from "./components/SettingsPage";
import UsagePage from "./components/UsagePage";
import { useAppStore } from "./lib/agent-store";
import { SHORTCUTS, inTextField } from "./lib/shortcuts";

export default function App() {
  const cwd = useAppStore((s) => s.cwd);
  const route = useAppStore((s) => s.route);
  const kind = useAppStore((s) => s.kind);
  const runtime = useAppStore((s) => s.runtime);
  const refreshSessions = useAppStore((s) => s.refreshSessions);
  const loadModels = useAppStore((s) => s.loadModels);
  const loadHarnessDefault = useAppStore((s) => s.loadHarnessDefault);
  const loadHosts = useAppStore((s) => s.loadHosts);
  const loadProviders = useAppStore((s) => s.loadProviders);
  const started = runtime !== null && !runtime.exited;

  useEffect(() => {
    void refreshSessions();
    void loadHosts();
    void loadModels();
    void loadHarnessDefault();
    void loadProviders();
  }, [refreshSessions, loadHosts, loadModels, loadHarnessDefault, loadProviders]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useAppStore.getState();
      const shortcut = SHORTCUTS.find((sc) => sc.match(e));
      if (!shortcut) return;
      // Escape belongs to whatever has focus first; the panels bind their own.
      if (shortcut.id === "abort") {
        if (inTextField(e.target) || !s.agent.streaming) return;
        e.preventDefault();
        void s.abort();
        return;
      }
      e.preventDefault();
      switch (shortcut.id) {
        case "palette":
          s.setCommandPaletteOpen(!s.commandPaletteOpen);
          break;
        case "tree":
          s.togglePanel("tree");
          break;
        case "status":
          s.togglePanel("status");
          break;
        case "terminal":
          s.togglePanel("terminal");
          break;
        case "new":
          if (started) void s.newSession();
          break;
        case "sidebar":
          s.toggleSidebar();
          break;
        case "settings":
          s.setRoute(s.route === "settings" ? "chat" : "settings");
          break;
        case "copy-last": {
          const last = [...s.agent.entries].reverse().find((entry) => entry.kind === "assistant");
          if (last?.kind === "assistant") {
            const body = last.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n\n");
            if (body) void navigator.clipboard.writeText(body);
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started]);

  return (
    <div data-testid="app-shell" className="flex h-full flex-col overflow-hidden">
      <Titlebar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col bg-ink-0">
          {route === "settings" ? (
            <SettingsPage />
          ) : route === "usage" ? (
            <UsagePage />
          ) : cwd && kind === "terminal" ? (
            <TerminalView />
          ) : cwd ? (
            <>
              <ReconnectBanner />
              <Transcript />
              <Composer />
            </>
          ) : (
            <Welcome />
          )}
        </main>
        {route === "chat" && kind === "chat" ? <TreeRail /> : null}
      </div>
      <ProvidersPanel />
      <FilesPanel />
      <StatusPanel />
      <TerminalPanel />
      <HistoryPanel />
      <CommandPalette />
    </div>
  );
}

/** First run: an invitation to act, and nothing else. */
function Welcome() {
  const setCwd = useAppStore((s) => s.setCwd);
  const openScratchWorkspace = useAppStore((s) => s.openScratchWorkspace);
  const activeMachine = useAppStore((s) => s.activeMachine);
  const setPanel = useAppStore((s) => s.setPanel);
  const openDialog = async () => {
    // The OS picker only sees this machine's disk, so a remote folder is
    // chosen in the file browser instead.
    if (activeMachine) {
      setPanel("files");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setCwd(dir);
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <div className="font-mono text-xl leading-none text-amber select-none">π</div>
      <div className="max-w-[400px] space-y-1.5 text-center">
        <h1 className="text-lg font-medium text-ink-text">Start a session</h1>
        <p className="text-md text-ink-dim">
          {activeMachine
            ? `Run pi or omp in a folder on ${activeMachine}, or start a scratch session there without choosing one.`
            : "Run pi or omp in a project folder, or start a generic scratch session without choosing one."}
        </p>
      </div>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row">
        <button
          onClick={() => void openScratchWorkspace()}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-amber-dim/60 bg-amber/10 px-4 font-mono text-sm text-amber hover:bg-amber/20"
        >
          <Sparkles size={13} />
          Start a scratch session
        </button>
        <button
          onClick={() => void openDialog()}
          className="h-8 rounded-md bg-amber px-4 font-mono text-sm text-on-accent hover:brightness-110"
        >
          {activeMachine ? `Choose a folder on ${activeMachine}` : "Choose a folder"}
        </button>
      </div>
    </div>
  );
}
