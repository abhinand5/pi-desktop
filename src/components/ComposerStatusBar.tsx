import { useEffect, useState } from "react";
import { GitBranch, Zap } from "lucide-react";
import { bridge, type GitStatus } from "../lib/bridge";
import { useAppStore } from "../lib/agent-store";
import { formatDuration, formatRate } from "../lib/speed";

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
        <span
          className={`flex shrink-0 items-center gap-1.5 ${speed.live ? "text-amber-dim" : ""}`}
          title={
            speed.live
              ? "Live estimate — the exact count arrives when the turn ends"
              : "Prompt processing is the wait before the first token; the rate is generation only"
          }
        >
          <Zap size={9} className={speed.live ? "animate-pulse" : ""} />
          {speed.promptMs !== null ? <span>{formatDuration(speed.promptMs)} to first token</span> : null}
          {speed.tokensPerSecond !== null ? <span>· {formatRate(speed.tokensPerSecond)}</span> : null}
        </span>
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

function homeRelative(path: string): string {
  const home = path.match(/^\/(?:home|Users)\/[^/]+/)?.[0];
  return home ? path.replace(home, "~") : path;
}
