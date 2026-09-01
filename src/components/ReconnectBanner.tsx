import { useAppStore } from "../lib/agent-store";

/**
 * What a lost connection means.
 *
 * An ssh channel can die while the agent keeps working on the far side, so a
 * remote drop is reported as unverified rather than as a death — reconnecting
 * and resuming is what settles it.
 */
export default function ReconnectBanner() {
  const verdict = useAppStore((s) => s.verdict);
  const runtime = useAppStore((s) => s.runtime);
  const sessionFile = useAppStore((s) => s.sessionFile);
  const reconnect = useAppStore((s) => s.reconnect);
  const connecting = useAppStore((s) => s.connecting);

  if (!runtime?.exited || verdict === null || verdict === "live") return null;

  const unverifiable = verdict === "unverifiable";

  return (
    <div
      className={`mx-auto mt-3 flex w-full max-w-[760px] items-center gap-3 rounded-md border px-3 py-2 ${
        unverifiable ? "border-amber-dim/50 bg-amber/8" : "border-line bg-ink-1"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className={`font-mono text-2xs tracking-wider uppercase ${unverifiable ? "text-amber" : "text-ink-faint"}`}>
          {unverifiable ? "connection lost" : "session ended"}
        </div>
        <div className="text-sm text-ink-dim">
          {unverifiable
            ? `The link to ${runtime.host} dropped. The agent may still be working there — reconnect to find out.`
            : "The agent exited. Start a new session, or resume this one from the sidebar."}
        </div>
      </div>
      {sessionFile ? (
        <button
          onClick={() => void reconnect()}
          disabled={connecting}
          className="h-control shrink-0 rounded-sm bg-amber px-3 font-mono text-xs text-on-accent hover:brightness-110 disabled:opacity-40"
        >
          {connecting ? "reconnecting…" : "reconnect"}
        </button>
      ) : null}
    </div>
  );
}
