import { useEffect, useRef } from "react";
import { MessageSquare, SquareTerminal, TerminalSquare } from "lucide-react";
import { useAppStore } from "../lib/agent-store";
import type { PtyProgram } from "../lib/bridge";

export interface MenuAnchor {
  cwd: string;
  target: string | null;
}

/**
 * What you can start in a project: a chat session, a shell, or a harness in a
 * real terminal.
 *
 * One menu behind every project, so the available ways to start work cannot
 * drift into offering different things.
 */
export default function NewInProject({ anchor, onClose }: { anchor: MenuAnchor; onClose: () => void }) {
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const openTerminal = useAppStore((s) => s.openTerminal);
  const setRoute = useAppStore((s) => s.setRoute);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Deferred a tick: the click that opened the menu is still propagating.
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const chat = () => {
    openWorkspace({ cwd: anchor.cwd, target: anchor.target, fresh: true });
    setRoute("chat");
    onClose();
  };

  const terminal = (program: PtyProgram) => {
    openTerminal({ cwd: anchor.cwd, target: anchor.target, program });
    setRoute("chat");
    onClose();
  };

  return (
    <div
      ref={ref}
      role="menu"
      className="overlay absolute top-full right-0 z-50 mt-1 w-[220px] overflow-hidden rounded-lg border border-line bg-ink-1 p-1"
    >
      <Item icon={<MessageSquare size={12} />} label="Chat session" hint="The transcript and tree" onClick={chat} />
      <div className="my-1 border-t border-line/70" />
      <Item
        icon={<SquareTerminal size={12} />}
        label="Terminal"
        hint="Your shell, in this folder"
        onClick={() => terminal("shell")}
      />
      <Item
        icon={<TerminalSquare size={12} />}
        label="pi in a terminal"
        hint="The full TUI"
        onClick={() => terminal("pi")}
      />
      <Item
        icon={<TerminalSquare size={12} />}
        label="omp in a terminal"
        hint="The full TUI"
        onClick={() => terminal("omp")}
      />
    </div>
  );
}

function Item({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left hover:bg-ink-2"
    >
      <span className="shrink-0 text-ink-faint">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm text-ink-text">{label}</span>
        <span className="block truncate font-mono text-2xs text-ink-faint">{hint}</span>
      </span>
    </button>
  );
}
