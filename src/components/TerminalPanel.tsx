import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useAppStore } from "../lib/agent-store";
import type { BashResult } from "../lib/store/types";

/**
 * A shell that runs where the agent runs.
 *
 * Not a PTY: each command runs to completion, and its output joins the agent's
 * context on the *next* prompt rather than immediately. That is how the harness
 * defines it, and the panel says so rather than pretending otherwise.
 */
export default function TerminalPanel() {
  const open = useAppStore((s) => s.openPanel === "terminal");
  const setPanel = useAppStore((s) => s.setPanel);
  const runBash = useAppStore((s) => s.runBash);
  const abortBash = useAppStore((s) => s.abortBash);
  const cwd = useAppStore((s) => s.cwd);
  const target = useAppStore((s) => s.target);

  const [command, setCommand] = useState("");
  const [runs, setRuns] = useState<Array<{ command: string; result: BashResult | null }>>([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [runs]);

  if (!open) return null;

  const run = async () => {
    const trimmed = command.trim();
    if (!trimmed || running) return;
    setHistory((h) => [trimmed, ...h].slice(0, 50));
    setCommand("");
    setRunning(true);
    setRuns((r) => [...r, { command: trimmed, result: null }]);
    const result = await runBash(trimmed);
    setRuns((r) => r.map((entry, i) => (i === r.length - 1 ? { ...entry, result } : entry)));
    setRunning(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={() => setPanel(null)}>
      <section
        className="flex h-[54vh] w-full max-w-[900px] flex-col overflow-hidden rounded-t-lg border border-line bg-ink-1 overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
          <h2 className="text-base text-ink-text">Terminal</h2>
          <span className="truncate font-mono text-2xs text-ink-faint">
            {target ?? "this machine"} · {cwd ?? "no project"}
          </span>
          <button onClick={() => setPanel(null)} aria-label="Close" className="ml-auto text-ink-faint hover:text-ink-text">
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-sm">
          {runs.length === 0 ? (
            <p className="text-ink-faint">
              Commands run in the agent's working directory. Output joins its context on your next prompt.
            </p>
          ) : null}
          {runs.map((entry, i) => (
            <div key={i} className="mb-3">
              <div className="flex gap-2">
                <span className="text-amber">$</span>
                <span className="selectable min-w-0 flex-1 break-all text-ink-text">{entry.command}</span>
                {entry.result ? (
                  <span className={entry.result.exitCode === 0 ? "text-ink-faint" : "text-red"}>
                    {entry.result.cancelled ? "stopped" : `exit ${entry.result.exitCode}`}
                  </span>
                ) : (
                  <span className="text-teal">running…</span>
                )}
              </div>
              {entry.result?.output ? (
                <pre className="selectable mt-1 max-h-72 overflow-auto border-l border-line pl-3 whitespace-pre-wrap text-ink-dim">
                  {entry.result.output}
                </pre>
              ) : null}
              {entry.result?.truncated ? (
                <p className="mt-0.5 text-2xs text-ink-faint">
                  Output truncated{entry.result.fullOutputPath ? ` — full log at ${entry.result.fullOutputPath}` : ""}.
                </p>
              ) : null}
            </div>
          ))}
          <div ref={bottom} />
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2">
          <span className="font-mono text-sm text-amber">$</span>
          <input
            autoFocus
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
              if (e.key === "ArrowUp" && history.length && !command) setCommand(history[0]);
            }}
            placeholder="Run a command"
            className="min-w-0 flex-1 bg-transparent font-mono text-sm text-ink-text placeholder:text-ink-faint"
          />
          {running ? (
            <button
              onClick={() => void abortBash()}
              className="h-control-sm rounded-sm border border-red/40 px-2 font-mono text-2xs text-red hover:bg-red/10"
            >
              stop
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
