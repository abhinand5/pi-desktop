import { useEffect, useReducer, useRef } from "react";
import { RotateCw, Trash2 } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../lib/agent-store";
import { getTerminal, openTerminal, restartTerminal, restyle, type TerminalSession } from "../lib/terminals";
import { projectName } from "../lib/store/workspace";

/**
 * A terminal workspace.
 *
 * The emulator is not owned by this component — it lives in the terminal
 * registry for as long as its process does, and this only borrows its DOM node.
 * Switching to another workspace and back leaves scrollback, the cursor, and a
 * half-typed command exactly where they were, which is the whole point of a
 * terminal that lives in a tab.
 */
export default function TerminalView() {
  const workspaceId = useAppStore((s) => s.activeWorkspaceId);
  const cwd = useAppStore((s) => s.cwd);
  const program = useAppStore((s) => s.program);
  const target = useAppStore((s) => s.target);
  const theme = useAppStore((s) => s.settings.theme);
  const glass = useAppStore((s) => s.settings.glass);
  const font = useAppStore((s) => s.settings.terminalFont);
  const closeWorkspace = useAppStore((s) => s.closeWorkspace);
  const host = useRef<HTMLDivElement>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const session: TerminalSession | null =
    workspaceId && cwd ? (getTerminal(workspaceId) ?? openTerminal({ workspaceId, program, cwd, host: target })) : null;

  // Adopt the persistent node, fit it to this container, and keep fitting.
  useEffect(() => {
    const parent = host.current;
    if (!parent || !session) return;
    parent.appendChild(session.element);
    if (!session.term.element) session.term.open(session.element);
    const refit = () => {
      // A container of zero size (mid-transition, or hidden) would compute a
      // nonsense geometry and the shell would redraw itself to match.
      if (parent.clientWidth > 0 && parent.clientHeight > 0) session.fit.fit();
    };
    refit();
    session.term.focus();

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refit);
    observer?.observe(parent);
    session.onChange.add(bump);
    return () => {
      observer?.disconnect();
      session.onChange.delete(bump);
      session.element.remove();
    };
  }, [session]);

  // The palette and the font live in CSS custom properties, so a change is
  // picked up by re-reading them rather than by rebuilding the terminal.
  useEffect(() => {
    if (!session) return;
    // A frame later: the attribute swap and the recomputed properties are not
    // simultaneous.
    const id = requestAnimationFrame(restyle);
    return () => cancelAnimationFrame(id);
  }, [theme, glass, font, session]);

  if (!workspaceId || !cwd || !session) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ink-0">
      <div className="min-h-0 flex-1 px-3 pt-2" ref={host} />

      {session.exit ? (
        <div className="mx-3 mb-2 flex items-center gap-3 rounded-md border border-line bg-ink-1 px-3 py-2">
          <span className="flex-1 text-sm text-ink-dim">
            {session.exit.code === 0 || session.exit.code === null
              ? "The process ended."
              : `The process exited with code ${session.exit.code}.`}
          </span>
          <button
            onClick={() => {
              restartTerminal({ workspaceId, program, cwd, host: target });
              bump();
            }}
            className="flex h-control-sm items-center gap-1.5 rounded-sm border border-line px-2.5 font-mono text-2xs text-ink-dim hover:border-line-strong hover:text-ink-text"
          >
            <RotateCw size={10} /> restart
          </button>
          <button
            onClick={() => void closeWorkspace(workspaceId)}
            className="flex h-control-sm items-center gap-1.5 rounded-sm border border-line px-2.5 font-mono text-2xs text-ink-faint hover:border-line-strong hover:text-red"
          >
            <Trash2 size={10} /> close
          </button>
        </div>
      ) : null}

      {/* Aligned with the terminal above it, which fills the pane — a centred
          column here would start somewhere the terminal does not. */}
      <div className="flex items-center gap-3 px-3 py-1.5 font-mono text-2xs whitespace-nowrap text-ink-faint">
        <span className="truncate" title={cwd}>
          {projectName(cwd)}
        </span>
        <span className="text-ink-dim">{PROGRAM_LABEL[program]}</span>
        {target ? <span className="text-teal">{target}</span> : null}
        {session.error ? <span className="min-w-0 flex-1 truncate text-red">{session.error}</span> : null}
      </div>
    </div>
  );
}

const PROGRAM_LABEL: Record<string, string> = {
  shell: "shell",
  pi: "pi",
  omp: "omp",
};
