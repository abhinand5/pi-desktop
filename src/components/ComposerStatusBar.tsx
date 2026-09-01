import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Zap } from "lucide-react";
import { bridge, type GitStatus } from "../lib/bridge";
import { useAppStore } from "../lib/agent-store";
import { formatDuration, formatRate, summarize } from "../lib/speed";

/** Where you are and how much room is left — the two facts you check without
 *  meaning to, kept under the composer rather than in a panel. */
export default function ComposerStatusBar() {
  const cwd = useAppStore((s) => s.cwd);
  const target = useAppStore((s) => s.target);
  const context = useAppStore((s) => s.context);
  const setPanel = useAppStore((s) => s.setPanel);
  const streaming = useAppStore((s) => s.agent.streaming);
  const speed = useAppStore((s) => s.speed);
  const showSpeed = useAppStore((s) => s.settings.showSpeed);

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
    <div className="mx-auto mt-1.5 flex w-full max-w-[760px] items-center gap-3 px-6 font-mono text-2xs text-ink-faint">
      <span className="min-w-0 max-w-[45%] truncate" title={cwd}>
        {homeRelative(cwd)}
      </span>
      {git?.isRepo ? (
        <span className="flex min-w-0 shrink items-center gap-1">
          <GitBranch size={10} className="shrink-0" />
          <span className="truncate">{git.branch}</span>
          {dirty > 0 ? <span className="text-amber-dim">{dirty} changed</span> : null}
        </span>
      ) : null}
      {showSpeed && speed && (speed.tokensPerSecond !== null || speed.promptMs !== null) ? (
        <SpeedReadout />
      ) : null}

      {context?.percent !== undefined ? (
        <button
          onClick={() => setPanel("status")}
          className="ml-auto shrink-0 hover:text-ink-dim"
          title="Open session status"
        >
          {context.tokens ? `${Math.round(context.tokens / 1000)}k` : ""} · {Math.round(context.percent)}% of
          context
        </button>
      ) : null}
    </div>
  );
}

/**
 * The last turn's throughput, and the session behind it.
 *
 * The line itself stays a single figure — that is what you glance at. The
 * session view is a click away because "was that turn slow, or is this session
 * slow?" is a different question, and it needs the other turns to answer.
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
  if (!speed) return null;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Session throughput"
        className={`flex items-center gap-1.5 ${speed.live ? "text-amber-dim" : "hover:text-ink-dim"}`}
      >
        <Zap size={9} className={speed.live ? "animate-pulse" : ""} />
        {speed.promptMs !== null ? <span>{formatDuration(speed.promptMs)} to first token</span> : null}
        {speed.tokensPerSecond !== null ? <span>· {formatRate(speed.tokensPerSecond)}</span> : null}
      </button>

      {open ? (
        <div className="overlay absolute bottom-full left-0 z-50 mb-1.5 w-[290px] overflow-hidden rounded-lg border border-line bg-ink-1">
          <div className="border-b border-line px-3 py-2">
            <div className="font-mono text-2xs tracking-wider text-ink-faint uppercase">this turn</div>
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

function homeRelative(path: string): string {
  const home = path.match(/^\/(?:home|Users)\/[^/]+/)?.[0];
  return home ? path.replace(home, "~") : path;
}
