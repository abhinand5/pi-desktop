import { useEffect, useRef, useState } from "react";
import { Archive, Trash2 } from "lucide-react";
import { useAppStore } from "../lib/agent-store";
import { projectName } from "../lib/store/workspace";

export default function WorkspaceActionsMenu({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const project = useAppStore((s) => s.projects[cwd]);
  const archiveProject = useAppStore((s) => s.archiveProject);
  const deleteProject = useAppStore((s) => s.deleteProject);
  const restoreProject = useAppStore((s) => s.restoreProject);
  const ref = useRef<HTMLDivElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
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

  if (!project) return null;

  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      className="overlay absolute top-full right-0 z-50 mt-1 w-[240px] overflow-hidden rounded-lg border border-line bg-ink-1 p-1"
    >
      {project.archived ? (
        <Item
          icon={<Archive size={12} />}
          label="Restore workspace"
          hint="Show this folder and its sessions again"
          onClick={() => {
            restoreProject(cwd);
            onClose();
          }}
        />
      ) : (
        <Item
          icon={<Archive size={12} />}
          label="Archive workspace"
          hint="Hide it from the rail; keep every session"
          onClick={() => void mutate(() => archiveProject(cwd))}
        />
      )}
      <div className="my-1 border-t border-line/70" />
      {confirmingDelete ? (
        <div className="rounded-sm border border-red/30 bg-red/5 p-2">
          <p className="mb-2 text-xs leading-snug text-ink-dim">
            Delete {projectName(cwd)} workspace? Sessions stay in History.
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void mutate(() => deleteProject(cwd))}
              aria-label="Delete workspace now"
              className="flex-1 rounded-sm bg-red/15 px-2 py-1 font-mono text-2xs text-red hover:bg-red/25 disabled:opacity-50"
            >
              {busy ? "deleting…" : "delete"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmingDelete(false)}
              className="flex-1 rounded-sm border border-line px-2 py-1 font-mono text-2xs text-ink-faint hover:text-ink-text disabled:opacity-50"
            >
              cancel
            </button>
          </div>
        </div>
      ) : (
        <Item
          icon={<Trash2 size={12} />}
          label="Delete workspace"
          hint="Remove it from this app; keep sessions in History"
          onClick={() => setConfirmingDelete(true)}
        />
      )}
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
      type="button"
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
