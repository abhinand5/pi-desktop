import { useEffect } from "react";
import Sidebar from "./components/Sidebar";
import Titlebar from "./components/Titlebar";
import Transcript from "./components/Transcript";
import Composer from "./components/Composer";
import ReconnectBanner from "./components/ReconnectBanner";
import ProvidersPanel from "./components/ProvidersPanel";
import FilesPanel from "./components/FilesPanel";
import CommandPalette from "./components/CommandPalette";
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
  const runtime = useAppStore((s) => s.runtime);
  const refreshSessions = useAppStore((s) => s.refreshSessions);
  const loadModels = useAppStore((s) => s.loadModels);
  const loadHosts = useAppStore((s) => s.loadHosts);
  const loadProviders = useAppStore((s) => s.loadProviders);
  const started = runtime !== null && !runtime.exited;

  useEffect(() => {
    void refreshSessions();
    void loadHosts();
    void loadModels();
    void loadProviders();
  }, [refreshSessions, loadHosts, loadModels, loadProviders]);

  useEffect(() => {
    if (started) void loadModels();
  }, [started, loadModels]);

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
        {route === "chat" ? <TreeRail /> : null}
      </div>
      <ProvidersPanel />
      <FilesPanel />
      <StatusPanel />
      <TerminalPanel />
      <CommandPalette />
    </div>
  );
}

/** First run: an invitation to act, and nothing else. */
function Welcome() {
  const setCwd = useAppStore((s) => s.setCwd);
  const openDialog = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setCwd(dir);
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6">
      <div className="font-mono text-xl leading-none text-amber select-none">π</div>
      <div className="max-w-[400px] space-y-1.5 text-center">
        <h1 className="text-lg font-medium text-ink-text">Open a project to begin</h1>
        <p className="text-md text-ink-dim">
          Sessions run pi or omp inside your project folder. The agent keeps its own credentials and
          session files; this app drives it and shows you the conversation tree.
        </p>
      </div>
      <button
        onClick={() => void openDialog()}
        className="h-8 rounded-md bg-amber px-4 font-mono text-sm text-ink-0 hover:brightness-110"
      >
        Choose a folder
      </button>
    </div>
  );
}
