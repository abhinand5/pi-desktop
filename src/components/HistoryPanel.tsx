import { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, RotateCw, Search, Trash2, X } from "lucide-react";
import type { SessionSummary } from "../lib/agent-state";
import { useAppStore } from "../lib/agent-store";
import { projectLabel, sessionLabel, shortAge } from "../lib/store/workspace";

/**
 * Every session the agent has on disk, in one place.
 *
 * The sidebar shows a project's recent sessions in the project — that is where
 * you look when you know which folder you were in. This is the other question:
 * "I was doing a thing last Tuesday and I do not remember where." So it is flat,
 * searchable, and every row names its project, because the project is the thing
 * you half-remember.
 *
 * The files are the harness's own. Nothing here writes to them except delete,
 * which is behind a confirm.
 */
export default function HistoryPanel() {
  const openPanel = useAppStore((s) => s.openPanel);
  const setPanel = useAppStore((s) => s.setPanel);
  const sessions = useAppStore((s) => s.sessions);
  const harness = useAppStore((s) => s.harness);
  const sessionFile = useAppStore((s) => s.sessionFile);
  const workspaces = useAppStore((s) => s.workspaces);
  const resumeSession = useAppStore((s) => s.resumeSession);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const refreshSessions = useAppStore((s) => s.refreshSessions);

  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const open = openPanel === "history";

  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPanel(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setPanel]);

  /** Paths already on screen somewhere, so a row can say so instead of
   *  opening a second workspace onto the same file. */
  const openPaths = useMemo(() => {
    const out = new Set<string>();
    for (const w of Object.values(workspaces)) {
      if (w.sessionFile) out.add(w.sessionFile);
      if (w.selectedSessionPath) out.add(w.selectedSessionPath);
    }
    return out;
  }, [workspaces]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...sessions]
      .filter(
        (s) =>
          !q ||
          (s.name ?? "").toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          (s.model ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  }, [sessions, query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink-0/70 pt-[12vh]">
      <div
        className="overlay flex max-h-[70vh] w-[640px] flex-col overflow-hidden rounded-lg border border-line bg-ink-1"
        role="dialog"
        aria-label="Session history"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={13} className="shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${harness} sessions by name, project, or model`}
            className="flex-1 bg-transparent py-2.5 text-md text-ink-text placeholder:text-ink-faint"
          />
          <button
            onClick={() => void refreshSessions()}
            aria-label="Reload sessions"
            title="Reload sessions"
            className="shrink-0 rounded-sm p-1 text-ink-faint hover:text-ink-dim"
          >
            <RotateCw size={12} />
          </button>
          <button
            onClick={() => setPanel(null)}
            aria-label="Close history"
            className="shrink-0 rounded-sm p-1 text-ink-faint hover:text-ink-text"
          >
            <X size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {matches.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-ink-faint">
              {sessions.length === 0
                ? `No sessions yet. These are ${harness}'s own files, read from ${
                    harness === "pi" ? "~/.pi/agent" : "~/.omp/agent"
                  }.`
                : "Nothing matches that."}
            </p>
          ) : (
            matches.map((s) => (
              <HistoryRow
                key={s.id + s.path}
                session={s}
                current={s.path === sessionFile}
                alreadyOpen={openPaths.has(s.path)}
                onOpen={() => {
                  void resumeSession(s);
                  setPanel(null);
                }}
                onDelete={() => void deleteSession(s.path)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function HistoryRow({
  session,
  current,
  alreadyOpen,
  onOpen,
  onDelete,
}: {
  session: SessionSummary;
  current: boolean;
  alreadyOpen: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const exact = session.timestamp?.slice(0, 16).replace("T", " ") ?? "";

  return (
    <div
      className={`group flex items-center gap-3 rounded-sm px-2.5 py-2 ${current ? "bg-ink-2" : "hover:bg-ink-2/60"}`}
    >
      <button onClick={onOpen} className="min-w-0 flex-1 text-left" title={`${exact}\n${session.path}`}>
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-md text-ink-text">{sessionLabel(session)}</span>
          {current ? <span className="shrink-0 font-mono text-2xs text-amber">open</span> : null}
          {!current && alreadyOpen ? (
            <span className="shrink-0 font-mono text-2xs text-ink-faint">in a tab</span>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-baseline gap-2 font-mono text-2xs text-ink-faint">
          {/* The project first: it is what you are actually scanning for. */}
          <span className="flex shrink-0 items-center gap-1 text-ink-dim">
            <FolderOpen size={9} />
            {projectLabel(session.cwd)}
          </span>
          <span className="shrink-0">{shortAge(session.timestamp)}</span>
          {session.model ? <span className="min-w-0 truncate">{session.model}</span> : null}
          {session.truncated ? (
            <span className="shrink-0 text-amber-dim" title="Only the head of this file was read">
              large
            </span>
          ) : null}
        </span>
      </button>

      {/* The full path, for the case where two projects share a leaf name. */}
      <span
        className="hidden max-w-[190px] shrink-0 truncate font-mono text-2xs text-ink-faint md:inline"
        title={session.cwd}
      >
        {session.cwd}
      </span>

      {confirming ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <button onClick={onDelete} className="font-mono text-2xs text-red hover:underline">
            delete
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="font-mono text-2xs text-ink-faint hover:text-ink-dim"
          >
            keep
          </button>
        </span>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${sessionLabel(session)}`}
          className="row-actions shrink-0 text-ink-faint hover:text-red"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}
