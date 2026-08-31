import { useEffect, useMemo, useRef } from "react";
import type { Entry } from "../lib/agent-state";
import { useAppStore } from "../lib/agent-store";
import { describeTurnError } from "../lib/errors";
import { activeBranch, alignUserEntries } from "../lib/tree";
import Markdown from "./Markdown";
import ToolCard from "./ToolCard";
import ThinkingStream from "./ThinkingStream";
import { formatDuration, formatRate } from "../lib/speed";
import {
  AssistantMessageActions,
  BranchChip,
  UserMessageActions,
} from "./MessageActions";

/**
 * The transcript, read down a spine.
 *
 * The spine is a real rule, not a column of loose dots: it is the thread of
 * the conversation, and its nodes mark what the agent actually did — a prompt,
 * a stream, a tool call, a session event. Where a prompt was answered more than
 * one way, the spine says so and offers the other answers.
 */
export default function Transcript() {
  const entries = useAppStore((s) => s.agent.entries);
  const streaming = useAppStore((s) => s.agent.streaming);
  const autoScroll = useAppStore((s) => s.settings.autoScroll);
  const wide = useAppStore((s) => s.settings.transcriptWidth === "wide");
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const entryIds = useEntryIds(entries);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (autoScroll && pinned.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries, streaming, autoScroll]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className={`relative mx-auto px-6 pt-6 pb-40 ${wide ? "max-w-[980px]" : "max-w-[760px]"}`}>
        {entries.length === 0 ? (
          <EmptyTranscript />
        ) : (
          <div className="relative">
            {/* The spine. Behind the nodes, stopping at the last one so it
                reads as a thread rather than a border. */}
            <div className="absolute top-2 bottom-2 left-[4px] w-px bg-line" aria-hidden />
            <div className="relative space-y-4">
              {entries.map((entry, i) => (
                <EntryRow
                  key={entry.seq}
                  entry={entry}
                  entryId={entryIds.get(entry.seq) ?? null}
                  last={i === entries.length - 1}
                />
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

/**
 * Maps transcript turns onto their session entries.
 *
 * Harness events carry no entry ids, so the k-th prompt in the transcript is
 * matched to the k-th prompt on the tree's active branch. When the two stop
 * describing the same conversation — after a compaction and resume — the match
 * is abandoned rather than guessed, and per-message branching falls back to the
 * tree rail, which always has real ids.
 */
function useEntryIds(entries: Entry[]): Map<number, string> {
  const tree = useAppStore((s) => s.tree);
  const leafId = useAppStore((s) => s.leafId);

  return useMemo(() => {
    const out = new Map<number, string>();
    const nodes = tree?.nodes ?? [];
    if (!nodes.length || !leafId) return out;
    const userEntries = entries.filter((e) => e.kind === "user");
    const ids = alignUserEntries(
      activeBranch(nodes, leafId),
      userEntries.map((e) => (e.kind === "user" ? e.text : "")),
    );
    if (!ids) return out;
    userEntries.forEach((entry, i) => out.set(entry.seq, ids[i]));
    return out;
  }, [entries, tree, leafId]);
}

function EntryRow({ entry, entryId, last }: { entry: Entry; entryId: string | null; last: boolean }) {
  return (
    <div className="group flex gap-3">
      <SpineNode entry={entry} />
      <div className="min-w-0 flex-1 pt-0.5">
        <EntryBody entry={entry} entryId={entryId} last={last} />
      </div>
    </div>
  );
}

function SpineNode({ entry }: { entry: Entry }) {
  const dot = "relative z-10 mt-[7px] h-[9px] w-[9px] shrink-0 rounded-full border bg-ink-0";
  switch (entry.kind) {
    case "user":
      return <div className={`${dot} border-amber bg-amber`} />;
    case "assistant":
      if (entry.streaming) return <div className={`${dot} spine-running border-amber`} />;
      if (entry.stopReason === "error") return <div className={`${dot} border-red bg-red/70`} />;
      return <div className={`${dot} border-amber-dim`} />;
    case "tool":
      return (
        <div
          className={`${dot} ${
            entry.status === "running"
              ? "spine-running border-teal bg-teal/80"
              : entry.status === "error"
                ? "border-red bg-red/70"
                : "border-teal bg-teal/60"
          }`}
        />
      );
    default:
      return (
        <div className="relative z-10 mt-[9px] h-[6px] w-[6px] shrink-0 rotate-45 bg-ink-faint ring-2 ring-ink-0" />
      );
  }
}

function EntryBody({ entry, entryId, last }: { entry: Entry; entryId: string | null; last: boolean }) {
  const harness = useAppStore((s) => s.harness);
  const thinkingDisplay = useAppStore((s) => s.settings.thinkingDisplay);
  const showSpeed = useAppStore((s) => s.settings.showSpeed);
  const speed = useAppStore((s) => s.speed);

  switch (entry.kind) {
    case "user":
      return (
        <div>
          {/* A quiet block, not a bubble: it separates your words from the
              agent's without turning the transcript into a chat app. */}
          <div className="selectable rounded-md bg-ink-1 px-3 py-2 text-md whitespace-pre-wrap text-ink-text">
            {entry.text}
          </div>
          {/* Actions and the branch chip share one row, so a turn with neither
              hovered nor branched costs no vertical space. */}
          {/* The chip leads: it is always visible, so the hover-only actions
              must not shift it sideways by reserving width ahead of it. */}
          <div className="mt-1 flex min-h-[24px] items-center gap-2">
            {entryId ? <BranchChip entryId={entryId} /> : null}
            <UserMessageActions text={entry.text} entryId={entryId} />
          </div>
        </div>
      );

    case "assistant": {
      const body = entry.blocks
        .filter((b) => b.kind === "text")
        .map((b) => b.text)
        .join("\n\n");
      return (
        <div className="space-y-3">
          {entry.blocks.map((block, i) => {
            if (block.kind === "text") {
              return (
                <div key={i}>
                  <Markdown text={block.text} />
                  {entry.streaming && i === entry.blocks.length - 1 ? (
                    <span className="streaming-caret" />
                  ) : null}
                </div>
              );
            }
            if (block.kind === "thinking") {
              return (
                <ThinkingStream
                  key={i}
                  text={block.text}
                  streaming={entry.streaming}
                  display={thinkingDisplay}
                />
              );
            }
            return (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 font-mono text-xs text-ink-dim"
              >
                <span className="text-teal">▸</span> {block.name || "tool"}
              </span>
            );
          })}

          {entry.stopReason === "error" && entry.errorMessage ? (
            <ErrorNote message={entry.errorMessage} harness={harness} />
          ) : null}

          {!entry.streaming ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <AssistantMessageActions text={body} />
              {entry.usage?.totalTokens ? (
                <span className="font-mono text-2xs text-ink-faint">
                  {entry.provider}/{entry.model} · {entry.usage.totalTokens.toLocaleString()} tok
                  {entry.usage.cost?.total ? ` · $${entry.usage.cost.total.toFixed(4)}` : ""}
                </span>
              ) : null}
              {showSpeed && last && speed && !speed.live ? <SpeedNote speed={speed} /> : null}
            </div>
          ) : showSpeed && speed?.live ? (
            <SpeedNote speed={speed} />
          ) : null}
        </div>
      );
    }

    case "tool":
      return <ToolCard tool={entry} />;

    case "bash":
      return (
        <div className="overflow-hidden rounded-md border border-line bg-ink-1">
          <div className="flex items-center gap-2 px-3 py-1.5">
            <span className="font-mono text-sm text-teal">$</span>
            <span className="selectable min-w-0 flex-1 truncate font-mono text-sm text-ink-text">
              {entry.command}
            </span>
            <span className="font-mono text-2xs tracking-wider uppercase">
              {entry.running ? (
                <span className="text-teal">running</span>
              ) : entry.exitCode === 0 ? (
                <span className="text-ink-faint">done</span>
              ) : (
                <span className="text-red">exit {entry.exitCode}</span>
              )}
            </span>
          </div>
          {entry.output ? (
            <pre className="selectable max-h-64 overflow-auto border-t border-line px-3 py-2 font-mono text-sm whitespace-pre-wrap text-ink-dim">
              {entry.output}
            </pre>
          ) : null}
        </div>
      );

    case "compaction":
      return (
        <div className="font-mono text-xs text-ink-faint">
          Context compacted · {entry.reason}
        </div>
      );

    case "retry":
      return (
        <div className="font-mono text-xs text-amber-dim">
          Retrying {entry.attempt}
          {entry.maxAttempts ? `/${entry.maxAttempts}` : ""} · {entry.errorMessage}
        </div>
      );
  }
}

function ErrorNote({ message, harness }: { message: string; harness: "pi" | "omp" }) {
  const { title, detail, hint } = describeTurnError(message, harness);
  return (
    <div className="rounded-md border border-red/30 bg-red/8 px-3 py-2 text-sm text-red">
      <div className="font-mono text-2xs tracking-wider uppercase opacity-80">{title}</div>
      <div className="selectable mt-0.5 text-ink-text/90">{detail}</div>
      {hint ? <div className="selectable mt-1 text-ink-dim">{hint}</div> : null}
    </div>
  );
}

function EmptyTranscript() {
  const cwd = useAppStore((s) => s.cwd);
  return (
    <div className="flex flex-col items-center gap-3 pt-24 pb-16 text-center">
      <div className="font-mono text-base text-amber-dim">›_</div>
      <p className="max-w-[400px] text-md text-ink-dim">
        Send a prompt to begin. Answers you do not like can be branched from rather than lost — every
        turn stays in the tree.
      </p>
      {cwd ? <p className="font-mono text-xs text-ink-faint">{cwd}</p> : null}
    </div>
  );
}

/** Prompt processing and generation rate for a turn. */
function SpeedNote({ speed }: { speed: NonNullable<ReturnType<typeof useAppStore.getState>["speed"]> }) {
  return (
    <span
      className={`font-mono text-2xs ${speed.live ? "text-amber-dim" : "text-ink-faint"}`}
      title="Prompt processing is the wait before the first token; the rate covers generation only"
    >
      {speed.promptMs !== null ? `${formatDuration(speed.promptMs)} to first token` : ""}
      {speed.promptMs !== null && speed.tokensPerSecond !== null ? " · " : ""}
      {speed.tokensPerSecond !== null ? formatRate(speed.tokensPerSecond) : ""}
      {speed.live ? " …" : ""}
    </span>
  );
}
