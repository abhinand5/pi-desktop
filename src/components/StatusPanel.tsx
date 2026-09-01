import { useEffect } from "react";
import { X } from "lucide-react";
import { useAppStore } from "../lib/agent-store";
import { formatCost } from "../lib/format";

/** Where the session stands: spend, context headroom, and what it is attached to. */
export default function StatusPanel() {
  const open = useAppStore((s) => s.openPanel === "status");
  const setPanel = useAppStore((s) => s.setPanel);
  const stats = useAppStore((s) => s.stats);
  const runtime = useAppStore((s) => s.runtime);
  const harness = useAppStore((s) => s.harness);
  const sessionFile = useAppStore((s) => s.sessionFile);
  const sessionName = useAppStore((s) => s.sessionName);
  const model = useAppStore((s) => s.selectedModel);
  const target = useAppStore((s) => s.target);
  const bridgeReady = useAppStore((s) => s.bridgeReady);
  const refreshStats = useAppStore((s) => s.refreshStats);

  useEffect(() => {
    if (open) void refreshStats();
  }, [open, refreshStats]);

  if (!open) return null;

  const usage = stats?.contextUsage;
  const pct = usage?.percent ?? null;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[12vh]" onClick={() => setPanel(null)}>
      <section
        className="w-[460px] overflow-hidden rounded-lg border border-line bg-ink-1 overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-base text-ink-text">Session status</h2>
          <button onClick={() => setPanel(null)} aria-label="Close" className="ml-auto text-ink-faint hover:text-ink-text">
            <X size={14} />
          </button>
        </header>

        {pct !== null ? (
          <div className="border-b border-line px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-2xs tracking-wider text-ink-faint uppercase">context used</span>
              <span className="font-mono text-sm text-ink-text">
                {usage?.tokens?.toLocaleString() ?? "—"} / {usage?.contextWindow?.toLocaleString() ?? "—"}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-3">
              <div
                className={`h-full rounded-full ${pct > 85 ? "bg-red" : pct > 60 ? "bg-amber" : "bg-teal"}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            {pct > 85 ? (
              <p className="mt-1.5 text-sm text-ink-dim">
                Nearly full. Compact the session, or branch from an earlier point to start fresh with context carried over.
              </p>
            ) : null}
          </div>
        ) : null}

        <dl className="divide-y divide-line/60">
          <Row label="Tokens in" value={stats?.tokens?.input?.toLocaleString()} />
          <Row label="Tokens out" value={stats?.tokens?.output?.toLocaleString()} />
          <Row label="Cache read" value={stats?.tokens?.cacheRead?.toLocaleString()} />
          <Row label="Cost" value={stats?.cost !== undefined ? formatCost(stats.cost) : undefined} />
          <Row label="Messages" value={stats?.totalMessages?.toLocaleString()} />
          <Row label="Tool calls" value={stats?.toolCalls?.toLocaleString()} />
          <Row label="Model" value={model ? `${model.provider}/${model.id}` : undefined} />
          <Row label="Agent" value={`${harness}${runtime?.pid ? ` · pid ${runtime.pid}` : ""}`} />
          <Row label="Running on" value={target ?? "this machine"} />
          <Row label="Session" value={sessionName ?? undefined} />
          <Row label="Session file" value={sessionFile ?? undefined} mono wrap />
          <Row
            label="Branching"
            value={bridgeReady ? "in place, one session file" : "unavailable — bridge did not load"}
          />
        </dl>
      </section>
    </div>
  );
}

function Row({ label, value, mono, wrap }: { label: string; value?: string; mono?: boolean; wrap?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-1.5">
      <dt className="w-28 shrink-0 text-sm text-ink-faint">{label}</dt>
      <dd
        className={`selectable min-w-0 flex-1 text-sm text-ink-text ${mono ? "font-mono text-xs" : ""} ${
          wrap ? "break-all" : "truncate"
        }`}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}
