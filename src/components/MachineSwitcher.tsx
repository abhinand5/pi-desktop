import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, HardDrive, Plus, Server, Trash2 } from "lucide-react";
import { useAppStore } from "../lib/agent-store";
import { isLive } from "../lib/store/workspace";

/**
 * Which machine you are working on.
 *
 * Machines behave like separate desktops: each one holds its own projects and
 * its own sessions, and moving between them starts and stops nothing. What you
 * leave generating on a build box is still generating when you come back to it,
 * and the count beside each name is how you can tell without going to look.
 *
 * The whole control is absent until a second machine exists. Someone who only
 * ever works on this laptop should never be asked to hold the idea that their
 * work happens somewhere in particular.
 */
export default function MachineSwitcher() {
  const hosts = useAppStore((s) => s.hosts);
  const activeMachine = useAppStore((s) => s.activeMachine);
  const setMachine = useAppStore((s) => s.setMachine);
  const workspaces = useAppStore((s) => s.workspaces);
  const removeHost = useAppStore((s) => s.removeHost);
  const showAddHost = useAppStore((s) => s.showAddHost);
  const setShowAddHost = useAppStore((s) => s.setShowAddHost);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // One machine means no machines to choose between. The add-a-host affordance
  // lives in the workspaces menu, so nothing here is lost by hiding it.
  if (hosts.length === 0 && !showAddHost) return null;

  const machines: Array<{ alias: string | null; label: string }> = [
    { alias: null, label: "this machine" },
    ...hosts.map((h) => ({ alias: h.alias, label: h.alias })),
  ];
  const current = machines.find((m) => m.alias === activeMachine) ?? machines[0];

  const countsFor = (alias: string | null) => {
    const mine = Object.values(workspaces).filter((w) => w.target === alias);
    return {
      sessions: mine.length,
      live: mine.filter((w) => isLive(w)).length,
      unread: mine.some((w) => w.unread),
    };
  };
  const here = countsFor(current.alias);

  return (
    <div ref={ref} className="relative px-3 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Machine: ${current.label}`}
        className="flex h-control w-full items-center gap-2 rounded-sm border border-line bg-ink-2 px-2.5 text-left hover:border-line-strong"
      >
        {current.alias ? (
          <Server size={12} className="shrink-0 text-teal" />
        ) : (
          <HardDrive size={12} className="shrink-0 text-ink-dim" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-text">{current.label}</span>
        <Dot live={here.live > 0} unread={here.unread} />
        <ChevronDown size={12} className="shrink-0 text-ink-faint" />
      </button>

      {open ? (
        <div
          role="menu"
          className="overlay absolute top-full right-3 left-3 z-50 mt-1 overflow-hidden rounded-lg border border-line bg-ink-1 p-1"
        >
          {machines.map((m) => {
            const counts = countsFor(m.alias);
            const active = m.alias === current.alias;
            return (
              <div key={m.alias ?? "local"} className="group flex items-center">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMachine(m.alias);
                    setOpen(false);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-ink-2"
                >
                  <span className="w-3 shrink-0">
                    {active ? <Check size={11} className="text-amber" /> : null}
                  </span>
                  {m.alias ? (
                    <Server size={11} className="shrink-0 text-teal" />
                  ) : (
                    <HardDrive size={11} className="shrink-0 text-ink-dim" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-text">{m.label}</span>
                  {/* What is happening over there, so you can leave it alone. */}
                  <span className="shrink-0 font-mono text-2xs text-ink-faint">
                    {counts.live > 0
                      ? `${counts.live} running`
                      : counts.sessions > 0
                        ? `${counts.sessions} open`
                        : ""}
                  </span>
                  <Dot live={counts.live > 0} unread={counts.unread} />
                </button>
                {m.alias ? (
                  <button
                    onClick={() => void removeHost(m.alias!)}
                    aria-label={`Remove ${m.alias}`}
                    title={`Remove ${m.alias}`}
                    className="mr-1 hidden shrink-0 rounded-sm p-1 text-ink-faint hover:text-red group-hover:block"
                  >
                    <Trash2 size={11} />
                  </button>
                ) : null}
              </div>
            );
          })}
          <div className="my-1 border-t border-line/70" />
          <button
            role="menuitem"
            onClick={() => {
              setShowAddHost(true);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-ink-2"
          >
            <span className="w-3 shrink-0" />
            <Plus size={11} className="shrink-0 text-ink-faint" />
            <span className="text-sm text-ink-dim">Connect to a machine…</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Amber for something you have not seen, teal for something still working. */
function Dot({ live, unread }: { live: boolean; unread: boolean }) {
  if (unread) return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />;
  if (live) return <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-teal" />;
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3" />;
}
