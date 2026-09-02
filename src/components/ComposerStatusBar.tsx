import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Zap } from "lucide-react";
import { bridge, type GitStatus } from "../lib/bridge";
import { useAppStore } from "../lib/agent-store";
import { formatDuration, formatRate, summarize } from "../lib/speed";
import { columnWidth } from "../lib/layout";
import { formatCost } from "../lib/format";
import { projectLabel } from "../lib/store/workspace";

/** Where you are and how much room is left — the two facts you check without
 *  meaning to, kept under the composer rather than in a panel. */
export default function ComposerStatusBar() {
  const cwd = useAppStore((s) => s.cwd);
  const target = useAppStore((s) => s.target);
  const context = useAppStore((s) => s.context);
  const stats = useAppStore((s) => s.stats);
  const setPanel = useAppStore((s) => s.setPanel);
  const streaming = useAppStore((s) => s.agent.streaming);
  const showSpeed = useAppStore((s) => s.settings.showSpeed);
  const wide = useAppStore((s) => s.settings.transcriptWidth === "wide");

  const [git, setGit] = useState<GitStatus | null>(null);

  // Refreshed when a turn settles, since that is when files change.
  useEffect(() => {
    if (!cwd || target) {
      setGit(null);
      return;
    }
    let live = true;
    void bridge
      .gitStatus(cwd)
      .then((s) => live && setGit(s))
      .catch(() => live && setGit(null));
    return () => {
      live = false;
    };
  }, [cwd, target, streaming]);

  if (!cwd) return null;
  const dirty = (git?.changed ?? 0) + (git?.staged ?? 0);

  return (
    // Where you are on the left, what the session has spent on the right.
    //
    // The folder path used to lead this line and no longer does: it is already
    // on screen in the chip directly above, and it was taking the room the
    // meters needed. The branch keeps its `title`, so the full path is still a
    // hover away — and where there is no branch it is the folder's name that
    // stands in, not the path again. A scratch session lives under app data,
    // is never a repo, and would otherwise print that whole path here.
    //
    // No `overflow-hidden` here, however tempting: the speed readout opens a
    // popover upward out of this row, and clipping the row clips the popover.
    <div
      className={`mx-auto mt-1.5 flex w-full items-center gap-4 px-6 font-mono text-2xs whitespace-nowrap text-ink-faint ${columnWidth(wide)}`}
    >
      {git?.isRepo ? (
        <span className="flex min-w-0 items-center gap-1.5" title={cwd}>
          <GitBranch size={10} className="shrink-0" />
          <span className="max-w-[220px] truncate text-ink-dim">{git.branch}</span>
          {dirty > 0 ? <span className="shrink-0 text-amber-dim">{dirty} changed</span> : null}
        </span>
      ) : (
        <span className="min-w-0 truncate" title={cwd}>
          {projectLabel(cwd)}
        </span>
      )}

      {/* The three session meters, in one group so they read as a set. */}
      <span className="ml-auto flex shrink-0 items-center gap-4">
        {stats?.cost !== undefined && stats.cost > 0 ? (
          <button
            onClick={() => setPanel("status")}
            title="What this session has cost so far, as the agent reports it"
            className="hover:text-ink-dim"
          >
            {formatCost(stats.cost)}
          </button>
        ) : null}

        {/* The readout decides for itself whether it has anything to say —
            after a restart the session average is all there is, and gating on
            a turn from this run would hide it. */}
        {showSpeed ? <SpeedReadout /> : null}

        {context?.percent !== undefined ? (
          <button onClick={() => setPanel("status")} className="hover:text-ink-dim" title="Open session status">
            {context.tokens ? `${Math.round(context.tokens / 1000)}k` : ""} · {Math.round(context.percent)}% of
            context
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Throughput: one number on the strip, the rest a click away.
 *
 * The strip shows the session's average rate, not the last turn's — an average
 * is the figure that means something at a glance, where a per-turn rate jumps
 * around with the length of the answer. While a turn is running it shows that
 * turn instead, because the average cannot include a turn that has not
 * finished, and the pulsing icon says which of the two you are looking at.
 *
 * Everything else — time to first token, median, best, totals — lives in the
 * popover, because "was that turn slow, or is this session slow?" is a
 * different question and needs the other turns to answer.
 */
function SpeedReadout() {
  const speed = useAppStore((s) => s.speed);
  const history = useAppStore((s) => s.speedHistory);
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

  const session = useMemo(() => summarize(history), [history]);
  // A turn has no rate of its own for its first ~120ms — under that the clock
  // resolution dominates and `measure` declines to divide — so a live turn
  // falls back to the session rather than unmounting the whole readout and
  // putting it back a moment later, once per turn.
  const liveRate = speed?.live ? speed.tokensPerSecond : null;
  // A resumed session has its remembered turns but no turn of its own yet, so
  // the average stands on its own until one runs.
  const rate = liveRate ?? session.meanRate ?? speed?.tokensPerSecond ?? null;
  if (rate === null) return null;
  // Only claim to be showing this turn when the number really is this turn's.
  const live = rate === liveRate;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={live ? "Throughput, this turn" : "Throughput, session average"}
        title={
          live
            ? "This turn so far — click for the session"
            : `Session average over ${session.turns} ${session.turns === 1 ? "turn" : "turns"} — click for the breakdown`
        }
        className={`flex items-center gap-1.5 ${live ? "text-amber-dim" : "hover:text-ink-dim"}`}
      >
        <Zap size={9} className={live ? "animate-pulse" : ""} />
        <span>{formatRate(rate)}</span>
      </button>

      {/* Right-anchored: the readout sits in the right half of the strip, so a
          left-anchored panel would hang off the column. */}
      {open ? (
        <div className="overlay absolute right-0 bottom-full z-50 mb-1.5 w-[290px] overflow-hidden rounded-lg border border-line bg-ink-1">
          {speed ? (
            <div className="border-b border-line px-3 py-2">
              <div className="font-mono text-2xs tracking-wider text-ink-faint uppercase">
                {speed.live ? "this turn" : "last turn"}
              </div>
              <Stat label="To first token" value={formatDuration(speed.promptMs)} />
              <Stat
                label="Generation"
                value={formatRate(speed.tokensPerSecond)}
                note={speed.live ? "estimated" : undefined}
              />
              <Stat
                label="Output"
                value={speed.outputTokens !== null ? `${speed.outputTokens.toLocaleString()} tok` : "—"}
                note={speed.live ? "estimated" : undefined}
              />
            </div>
          ) : null}

          <div className="px-3 py-2">
            <div className="font-mono text-2xs tracking-wider text-ink-faint uppercase">
              this session · {session.turns} {session.turns === 1 ? "turn" : "turns"}
            </div>
            {session.turns === 0 ? (
              <p className="mt-1 text-sm text-ink-faint">
                Averages appear once a turn has finished. The figures above are still running.
              </p>
            ) : (
              <>
                <Stat label="Mean rate" value={formatRate(session.meanRate)} note="by time" />
                <Stat label="Median rate" value={formatRate(session.medianRate)} />
                <Stat label="Best rate" value={formatRate(session.bestRate)} />
                <Stat label="Mean wait" value={formatDuration(session.meanPromptMs)} />
                <Stat label="Fastest start" value={formatDuration(session.bestPromptMs)} />
                <Stat
                  label="Generated"
                  value={`${session.totalTokens.toLocaleString()} tok in ${formatDuration(session.totalGenerateMs)}`}
                />
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="mt-1 flex items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate text-sm text-ink-dim">{label}</span>
      {note ? <span className="shrink-0 font-mono text-2xs text-ink-faint">{note}</span> : null}
      <span className="shrink-0 font-mono text-xs text-ink-text">{value}</span>
    </div>
  );
}

