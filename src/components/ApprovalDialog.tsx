import { useEffect, useRef, useState } from "react";
import type { Approval } from "../lib/agent-state";
import { useAppStore } from "../lib/agent-store";

/**
 * The agent is blocked, waiting for an answer.
 *
 * All four blocking methods are handled, and each answers in the shape the
 * harness actually reads: `select` returns the chosen option *string*,
 * `confirm` returns a boolean under `confirmed`, `input` and `editor` return
 * text under `value`. Answering in the wrong shape reads as a cancellation,
 * which quietly denies whatever the agent asked for.
 */
export default function ApprovalDialog() {
  const approval = useAppStore((s) => s.agent.pendingApproval);
  const respond = useAppStore((s) => s.respondApproval);
  if (!approval) return null;
  return <Dialog key={approval.requestId} approval={approval} onRespond={respond} />;
}

function Dialog({
  approval,
  onRespond,
}: {
  approval: Approval;
  onRespond: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [text, setText] = useState(approval.prefill ?? "");
  const [remaining, setRemaining] = useState<number | null>(
    approval.timeout ? Math.ceil(approval.timeout / 1000) : null,
  );
  const firstAction = useRef<HTMLButtonElement>(null);

  // The agent resolves the dialog itself when the timeout expires, so the
  // countdown is the difference between deciding and having it decided.
  useEffect(() => {
    if (remaining === null) return;
    const tick = setInterval(() => setRemaining((r) => (r === null ? null : Math.max(0, r - 1))), 1000);
    return () => clearInterval(tick);
  }, [remaining === null]);

  useEffect(() => {
    firstAction.current?.focus();
  }, []);

  const cancel = () => void onRespond({ cancelled: true });

  return (
    <div
      role="dialog"
      aria-label={approval.title}
      onKeyDown={(e) => {
        if (e.key === "Escape") cancel();
      }}
      className="mb-2 rounded-md border border-amber-dim/50 bg-amber/8 px-3 py-2.5"
    >
      <div className="flex items-baseline gap-2">
        <span className="eyebrow font-mono text-2xs tracking-wider text-amber uppercase">waiting on you</span>
        {remaining !== null ? (
          <span className="ml-auto font-mono text-2xs text-ink-faint">
            {remaining > 0 ? `${remaining}s left` : "deciding without you…"}
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-base text-ink-text">{approval.title}</p>
      {approval.message ? <p className="mt-0.5 text-sm text-ink-dim">{approval.message}</p> : null}

      {approval.method === "input" || approval.method === "editor" ? (
        <textarea
          autoFocus
          rows={approval.method === "editor" ? 5 : 1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={approval.placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (approval.method === "input" || e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void onRespond({ value: text });
            }
          }}
          className="mt-2 w-full resize-y rounded-sm border border-line bg-ink-0 px-2 py-1.5 font-mono text-sm text-ink-text placeholder:text-ink-faint focus:border-amber-dim"
        />
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {approval.method === "select" && approval.options?.length ? (
          approval.options.map((option, i) => (
            <button
              key={option}
              ref={i === 0 ? firstAction : undefined}
              onClick={() => void onRespond({ value: option })}
              className={
                i === 0
                  ? "h-control rounded-sm bg-amber px-3 font-mono text-xs text-on-accent hover:brightness-110"
                  : "h-control rounded-sm border border-line bg-ink-2 px-3 font-mono text-xs text-ink-text hover:border-line-strong"
              }
            >
              {option}
            </button>
          ))
        ) : approval.method === "confirm" ? (
          <>
            <button
              ref={firstAction}
              onClick={() => void onRespond({ confirmed: true })}
              className="h-control rounded-sm bg-amber px-3 font-mono text-xs text-on-accent hover:brightness-110"
            >
              Yes
            </button>
            <button
              onClick={() => void onRespond({ confirmed: false })}
              className="h-control rounded-sm border border-line bg-ink-2 px-3 font-mono text-xs text-ink-text hover:border-line-strong"
            >
              No
            </button>
          </>
        ) : approval.method === "input" || approval.method === "editor" ? (
          <button
            onClick={() => void onRespond({ value: text })}
            className="h-control rounded-sm bg-amber px-3 font-mono text-xs text-on-accent hover:brightness-110"
          >
            Send
          </button>
        ) : null}

        <button
          onClick={cancel}
          className="ml-auto h-control rounded-sm px-2.5 font-mono text-xs text-ink-faint hover:text-ink-dim"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
