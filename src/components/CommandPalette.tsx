import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../lib/agent-store";
import { builtinCommands, createRegistry, harnessCommands, type Command } from "../lib/commands";
import { nearestUserEntry } from "../lib/tree";
import { SHORTCUTS } from "../lib/shortcuts";

/**
 * ⌘K. The same registry the composer uses, plus the app-level actions that
 * have no slash command — so there is one list of what this app can do, not two.
 */
export default function CommandPalette() {
  const open = useAppStore((s) => s.commandPaletteOpen);
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const harnessCmds = useAppStore((s) => s.harnessCommands);
  const active = useAppStore((s) => s.runtime !== null && !s.runtime.exited);
  const streaming = useAppStore((s) => s.agent.streaming);
  const bridgeReady = useAppStore((s) => s.bridgeReady);
  const treeSize = useAppStore((s) => s.tree?.nodes.length ?? 0);
  const setNotice = useAppStore((s) => s.setNotice);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const store = useAppStore;

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  const commands = useMemo(() => {
    const s = store.getState();
    const registry = createRegistry([
      builtinCommands({
        compact: (instructions) => void s.compact(instructions),
        newSession: () => void s.newSession(),
        rename: () => setNotice("Rename from the composer: /name <session name>"),
        export: () => void s.exportSession().then((p) => setNotice(p ? `Exported to ${p}` : null)),
        openTree: () => s.setPanel("tree"),
        openStatus: () => s.setPanel("status"),
        openTerminal: () => s.setPanel("terminal"),
        openProviders: () => s.setPanel("providers"),
        retryLast: () => {
          const target = nearestUserEntry(store.getState().tree?.nodes ?? [], store.getState().leafId);
          if (target) void store.getState().retryEntry(target.id);
        },
        copyLast: () => {
          const last = [...store.getState().agent.entries].reverse().find((e) => e.kind === "assistant");
          if (last?.kind === "assistant") {
            void navigator.clipboard.writeText(
              last.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n\n"),
            );
          }
        },
        fork: () => {
          const target = nearestUserEntry(store.getState().tree?.nodes ?? [], store.getState().leafId);
          if (target) void store.getState().forkFrom(target.id);
        },
        clone: () => void s.cloneSession(),
        abort: () => void s.abort(),
      }),
      appCommands(),
      harnessCommands(harnessCmds),
    ]);
    return registry.match(query, {
      active,
      streaming,
      hasSession: active,
      hasTree: treeSize > 0,
      bridgeReady,
    }, 40);
  }, [store, query, harnessCmds, active, streaming, treeSize, bridgeReady, setNotice]);

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, commands.length - 1)));
  }, [commands.length]);

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const run = async (command: Command) => {
    setOpen(false);
    const outcome = await command.run("", {
      active,
      streaming,
      hasSession: active,
      hasTree: treeSize > 0,
      bridgeReady,
    });
    if (outcome.kind === "error") setNotice(outcome.message);
    if (outcome.kind === "passthrough") void store.getState().sendPrompt(`/${command.name}`);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[14vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[540px] overflow-hidden rounded-lg border border-line bg-ink-1 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => (i + 1) % Math.max(1, commands.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => (i - 1 + commands.length) % Math.max(1, commands.length));
            } else if (e.key === "Enter" && commands[index]) {
              e.preventDefault();
              void run(commands[index]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder="Search commands"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-md text-ink-text placeholder:text-ink-faint"
        />
        <div ref={listRef} className="max-h-[340px] overflow-y-auto p-1.5">
          {commands.length === 0 ? (
            <div className="px-3 py-5 text-center text-sm text-ink-faint">Nothing matches that.</div>
          ) : (
            commands.map((c, i) => (
              <button
                key={c.id}
                data-selected={i === index}
                onClick={() => void run(c)}
                onMouseEnter={() => setIndex(i)}
                className={`flex w-full items-baseline gap-2 rounded-sm px-3 py-2 text-left ${
                  i === index ? "bg-ink-2 text-ink-text" : "text-ink-dim"
                }`}
              >
                <span className="shrink-0 text-base">{c.title}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-faint">{c.description}</span>
                <Hint command={c} />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Hint({ command }: { command: Command }) {
  const shortcut = SHORTCUTS.find((s) => s.id === shortcutIdFor(command.name));
  if (shortcut) {
    return <span className="shrink-0 font-mono text-2xs text-ink-faint">{shortcut.keys}</span>;
  }
  return <span className="shrink-0 font-mono text-2xs text-ink-faint">/{command.name}</span>;
}

function shortcutIdFor(name: string): string | null {
  switch (name) {
    case "tree":
      return "tree";
    case "status":
      return "status";
    case "terminal":
      return "terminal";
    case "new":
      return "new";
    default:
      return null;
  }
}

/** Palette-only actions: no slash form, because they change what the app is
 *  pointed at rather than acting on the conversation. */
function appCommands(): Command[] {
  const s = () => useAppStore.getState();
  const make = (name: string, title: string, description: string, run: () => void): Command => ({
    id: `app:${name}`,
    name,
    title,
    description,
    source: "desktop",
    run: () => {
      run();
      return { kind: "handled" };
    },
  });
  return [
    make("use-pi", "Switch to pi", "Run sessions with the pi agent", () => s().setHarness("pi")),
    make("use-omp", "Switch to omp", "Run sessions with the omp agent", () => s().setHarness("omp")),
    make("start", "Start session", "Launch the agent in this project", () => void s().startRuntime()),
    make("stop", "Stop session", "Shut the agent down", () => void s().stopRuntime()),
    make("reconnect", "Reconnect", "Reattach to the session after losing contact", () => void s().reconnect()),
    make("reload-sessions", "Reload sessions", "Rescan the agent's session files", () => void s().refreshSessions()),
    make("reload-models", "Reload models", "Rescan the model catalog", () => void s().loadModels()),
    make("files", "Browse remote files", "Look around the connected machine", () => s().setPanel("files")),
  ];
}
