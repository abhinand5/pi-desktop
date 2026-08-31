import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAppStore } from "../lib/agent-store";
import type { DayUsage, UsageReport, UsageWindow } from "../lib/store/types";

const WINDOWS: Array<{ value: UsageWindow; label: string }> = [
  { value: "all", label: "All" },
  { value: "30d", label: "30d" },
  { value: "7d", label: "7d" },
];

/**
 * What this agent has actually done.
 *
 * Every figure is derived from the harness's own session files, so it covers
 * work done in the terminal as well as here — and it costs nothing to keep,
 * because the app stores no telemetry of its own.
 */
export default function UsagePage() {
  const usage = useAppStore((s) => s.usage);
  const loading = useAppStore((s) => s.usageLoading);
  const error = useAppStore((s) => s.usageError);
  const window_ = useAppStore((s) => s.usageWindow);
  const setWindow = useAppStore((s) => s.setUsageWindow);
  const loadUsage = useAppStore((s) => s.loadUsage);
  const harness = useAppStore((s) => s.harness);

  const [tab, setTab] = useState<"overview" | "models">("overview");

  useEffect(() => {
    void loadUsage();
  }, [loadUsage, harness]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[860px] px-8 py-8">
        <header className="mb-5 flex items-center gap-3">
          <div className="flex overflow-hidden rounded-md border border-line">
            {(["overview", "models"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
                className={`px-3 py-1.5 text-md capitalize ${
                  tab === t ? "bg-ink-3 text-ink-text" : "text-ink-faint hover:bg-ink-2 hover:text-ink-dim"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <button
            onClick={() => void loadUsage()}
            aria-label="Reload"
            className="text-ink-faint hover:text-ink-text"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>

          <div className="ml-auto flex overflow-hidden rounded-md border border-line">
            {WINDOWS.map((w) => (
              <button
                key={w.value}
                onClick={() => setWindow(w.value)}
                aria-pressed={window_ === w.value}
                className={`px-2.5 py-1.5 font-mono text-xs ${
                  window_ === w.value ? "bg-ink-3 text-ink-text" : "text-ink-faint hover:bg-ink-2 hover:text-ink-dim"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </header>

        {error ? (
          <p className="rounded-md border border-red/30 bg-red/8 px-3 py-2 text-sm text-red">{error}</p>
        ) : null}

        {!usage && loading ? (
          <p className="py-16 text-center text-md text-ink-faint">Reading {harness}'s session files…</p>
        ) : null}

        {usage && usage.messages === 0 ? (
          <p className="py-16 text-center text-md text-ink-faint">
            Nothing recorded in this window yet. Run a session and it will show up here.
          </p>
        ) : null}

        {usage && usage.messages > 0 ? (
          tab === "overview" ? (
            <Overview usage={usage} />
          ) : (
            <Models usage={usage} />
          )
        ) : null}
      </div>
    </div>
  );
}

function Overview({ usage }: { usage: UsageReport }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Sessions" value={usage.sessions.toLocaleString()} />
        <Tile label="Messages" value={usage.messages.toLocaleString()} />
        <Tile label="Total tokens" value={compact(usage.tokens.total)} />
        <Tile label="Active days" value={usage.activeDays.toLocaleString()} />
        <Tile label="Current streak" value={`${usage.currentStreak}d`} />
        <Tile label="Longest streak" value={`${usage.longestStreak}d`} />
        <Tile label="Peak hour" value={usage.peakHour === null ? "—" : formatHour(usage.peakHour)} />
        <Tile label="Spend" value={usage.cost > 0 ? `$${usage.cost.toFixed(2)}` : "—"} />
      </div>

      <Heatmap days={usage.byDay} />

      <p className="mt-3 text-sm text-ink-faint">{comparison(usage.tokens.total)}</p>
    </>
  );
}

function Models({ usage }: { usage: UsageReport }) {
  const max = Math.max(1, ...usage.byModel.map((m) => m.tokens.total));
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-ink-1">
      {usage.byModel.map((m) => (
        <div key={m.model} className="border-b border-line/60 px-4 py-3 last:border-b-0">
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink-text">{m.model}</span>
            <span className="shrink-0 font-mono text-2xs text-ink-faint">
              {m.messages.toLocaleString()} msg · {compact(m.tokens.total)} tok
              {m.cost > 0 ? ` · $${m.cost.toFixed(2)}` : ""}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-3">
            <div
              className="h-full rounded-full bg-amber-dim"
              style={{ width: `${(m.tokens.total / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-ink-1 px-3 py-2.5">
      <div className="text-sm text-ink-faint">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tracking-tight text-ink-text tabular-nums">{value}</div>
    </div>
  );
}

/** A year of weeks, which is what fills the card at this cell size. */
const WEEKS = 53;

/**
 * A year of activity, one square per day.
 *
 * Columns are weeks and rows are weekdays, so a habit reads as a horizontal
 * band and a burst reads as a vertical one.
 */
function Heatmap({ days }: { days: DayUsage[] }) {
  const { cells, max } = useMemo(() => {
    const byDate = new Map(days.map((d) => [d.date, d]));
    const last = days.at(-1)?.date;
    if (!last) return { cells: [] as Array<DayUsage | null>, max: 0 };

    const end = new Date(`${last}T00:00:00Z`);
    // Pad forward to Saturday so the final column is a whole week.
    end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 7 * WEEKS + 1);

    const out: Array<DayUsage | null> = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      out.push(byDate.get(key) ?? { date: key, sessions: 0, messages: 0, tokens: 0 });
    }
    return { cells: out, max: Math.max(1, ...days.map((d) => d.tokens)) };
  }, [days]);

  if (!cells.length) return null;

  // Column-major: seven rows of weekdays, one column per week.
  const weeks = Math.ceil(cells.length / 7);

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-ink-1 p-3">
      <div
        className="grid grid-flow-col gap-[3px]"
        style={{ gridTemplateRows: "repeat(7, 10px)", gridTemplateColumns: `repeat(${weeks}, 10px)` }}
      >
        {cells.map((cell) => (
          <div
            key={cell!.date}
            title={`${cell!.date} · ${cell!.messages} messages · ${compact(cell!.tokens)} tokens`}
            className="h-[10px] w-[10px] rounded-[2px]"
            style={{ backgroundColor: shade(cell!.tokens, max) }}
          />
        ))}
      </div>
    </div>
  );
}

/** Four steps of amber over the empty-cell ink, so density reads at a glance. */
function shade(tokens: number, max: number): string {
  if (tokens <= 0) return "var(--color-ink-3)";
  const step = Math.min(4, Math.ceil((tokens / max) * 4));
  return `color-mix(in srgb, var(--color-amber) ${step * 22 + 12}%, var(--color-ink-2))`;
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function formatHour(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

/** A yardstick for a number that is otherwise hard to feel. */
function comparison(tokens: number): string {
  if (tokens <= 0) return "";
  const books = tokens / 180_000; // ~length of a novel in tokens
  if (books >= 1) {
    return `That is about ${books >= 10 ? Math.round(books) : books.toFixed(1)}× the length of a novel.`;
  }
  return `That is about ${Math.round(books * 100)}% of a novel's length.`;
}
