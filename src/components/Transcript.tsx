import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Loader2, Paperclip } from "lucide-react";
import type { Entry } from "../lib/agent-state";
import { useAppStore } from "../lib/agent-store";
import { describeTurnError } from "../lib/errors";
import { activeBranch, alignUserEntries } from "../lib/tree";
import Markdown from "./Markdown";
import ToolCard from "./ToolCard";
import ThinkingStream from "./ThinkingStream";
import { formatDuration, formatRate } from "../lib/speed";
import { columnWidth } from "../lib/layout";
import { projectName } from "../lib/store/workspace";
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
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);
  // Mirrors `pinned` for rendering. The ref is what the scroll handler reads on
  // every frame; this only changes when the answer flips, so the jump button
  // appearing costs one render rather than one per scroll event.
  const [detached, setDetached] = useState(false);

  const entryIds = useEntryIds(entries);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    setDetached(false);
    // Left at the current position, not the destination: a smooth scroll
    // arrives as a run of ordinary scroll events, and a `lastTop` ahead of
    // them would read every one of those frames as scrolling up.
    lastTop.current = el.scrollTop;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && autoScroll && pinned.current) lastTop.current = scrollToBottom(el);
  }, [entries, streaming, autoScroll]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    // Only scrolling *up* detaches the view. Streaming content grows the page
    // without moving `scrollTop`, so a distance-from-bottom test on its own
    // would unpin a reader who never touched anything — and reading direction
    // instead of guessing at gestures keeps the wheel, the scrollbar, the
    // keyboard, and touch all on one path.
    const onScroll = () => {
      const top = el.scrollTop;
      const distance = el.scrollHeight - top - el.clientHeight;
      if (top < lastTop.current - 1) {
        if (distance > NEAR_BOTTOM) pinned.current = false;
      } else if (distance <= NEAR_BOTTOM) {
        pinned.current = true;
      }
      lastTop.current = top;
      setDetached(!pinned.current);
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    // Entries change before they finish laying out — code blocks highlight,
    // tool output expands, images load — so follow the height as well.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (autoScroll && pinned.current) lastTop.current = scrollToBottom(el);
          });
    observer?.observe(content);

    return () => {
      el.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [autoScroll]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scrollRef} data-transcript className="flex-1 overflow-y-auto">
      <div
        ref={contentRef}
        className={`relative mx-auto px-6 pt-6 pb-8 ${columnWidth(wide)}`}
      >
        {entries.length === 0 ? (
          <EmptyTranscript />
        ) : (
          <div className="relative">
            <div className="relative flex flex-col gap-(--spacing-entry)">
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
      </div>
    </div>

      {/* Only while the newest output is off-screen — a permanent button would
          be a permanent claim that you are missing something. */}
      {detached && entries.length > 0 ? (
        <button
          onClick={jumpToLatest}
          aria-label="Jump to the latest output"
          className="absolute bottom-3 left-1/2 z-20 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-ink-2 pr-3 pl-2.5 font-mono text-2xs text-ink-dim overlay hover:text-ink-text"
        >
          <ArrowDown size={11} className={streaming ? "text-amber" : ""} />
          {streaming ? "still writing" : "latest"}
        </button>
      ) : null}
    </div>
  );
}
/** How close to the end still counts as reading the newest output. */
const NEAR_BOTTOM = 48;

/**
 * Follow the transcript's known scroll container instead of relying on
 * `scrollIntoView` to choose an ancestor while streaming layout is changing.
 * Returns the resting position so the scroll handler does not read our own
 * jump as the reader moving away.
 */
function scrollToBottom(el: HTMLElement): number {
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  return el.scrollTop;
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
    <div className="entry-row group relative">
      <SpineNode entry={entry} />
      <span aria-hidden />
      <div className="min-w-0 pt-0.5">
        <EntryBody entry={entry} entryId={entryId} last={last} />
      </div>
      {/* The margin. Empty in classic, where the same figures sit under the
          message instead — see `.lane` in index.css. */}
      <div className="lane self-end pb-1 pl-4">
        <EntryMeta entry={entry} stacked />
      </div>
    </div>
  );
}

/**
 * What a message cost, in the two places it can go.
 *
 * `stacked` is the margin treatment: one figure per line, right-aligned, so a
 * column of them reads down. Inline is the original — a single row under the
 * message. The numbers are the same either way; only the shape changes, and
 * which shape you get is the skin's business rather than this component's.
 */
function EntryMeta({ entry, stacked }: { entry: Entry; stacked?: boolean }) {
  if (entry.kind !== "assistant" || !entry.usage?.totalTokens) return null;
  const cost = entry.usage.cost?.total;

  if (stacked) {
    return (
      <div className="text-right font-mono text-2xs tabular-nums text-ink-faint">
        <div>{compactTokens(entry.usage.totalTokens)}</div>
        {cost ? <div className="text-amber-dim">${cost.toFixed(4)}</div> : null}
      </div>
    );
  }
  return (
    <span className="font-mono text-2xs text-ink-faint">
      {entry.provider}/{entry.model} · {entry.usage.totalTokens.toLocaleString()} tok
      {cost ? ` · $${cost.toFixed(4)}` : ""}
    </span>
  );
}

/** "28,784" is four characters too many for an 84px margin. */
function compactTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k tok`;
  return `${(n / 1_000_000).toFixed(1)}M tok`;
}

/**
 * The gutter mark: who is speaking, and what they are doing.
 *
 * This was a thread with a dot on it per entry, and the dots all rendered as
 * the same hollow ring — a rail that cost sixty pixels and told you nothing,
 * running alongside a second rail that the prompt drew for itself. One mark
 * does both jobs now: it spans the entry it belongs to, so its *length* is the
 * shape of the turn, and its colour says whose turn it is. The live path is the
 * only one that gets the accent, which is the rule the whole palette is built
 * on.
 */
function SpineNode({ entry }: { entry: Entry }) {
  const bar = "w-full rounded-full";
  switch (entry.kind) {
    case "user":
      return <div className={`${bar} bg-amber`} aria-hidden />;
    case "assistant":
      if (entry.streaming) return <div className={`${bar} spine-running bg-amber`} aria-hidden />;
      if (entry.stopReason === "error") return <div className={`${bar} bg-red`} aria-hidden />;
      return <div className={`${bar} bg-line-strong`} aria-hidden />;
    case "tool":
      return (
        <div
          className={`${bar} ${
            entry.status === "running"
              ? "spine-running bg-teal"
              : entry.status === "error"
                ? "bg-red"
                : "bg-teal/50"
          }`}
          aria-hidden
        />
      );
    default:
      return <div className={`${bar} bg-ink-3`} aria-hidden />;
  }
}

function EntryBody({ entry, entryId, last }: { entry: Entry; entryId: string | null; last: boolean }) {
  const harness = useAppStore((s) => s.harness);
  const thinkingDisplay = useAppStore((s) => s.settings.thinkingDisplay);
  const thinkingPace = useAppStore((s) => s.settings.thinkingPace);
  const showSpeed = useAppStore((s) => s.settings.showSpeed);
  const speed = useAppStore((s) => s.speed);

  switch (entry.kind) {
    case "user":
      return (
        <div>
          {/* A quiet block, not a bubble: it separates your words from the
              agent's without turning the transcript into a chat app. */}
          <div className="prompt-block selectable rounded-md bg-ink-1 px-3 py-2 text-md whitespace-pre-wrap text-ink-text">
            {entry.text}
          </div>
          {entry.imageCount ? (
            <div
              className="mt-1.5 inline-flex items-center gap-1.5 rounded-sm border border-line bg-ink-2 px-2 py-1 font-mono text-2xs text-ink-faint"
              aria-label={`${entry.imageCount} ${entry.imageCount === 1 ? "image" : "images"} attached`}
            >
              <Paperclip size={11} aria-hidden />
              {entry.imageCount === 1 ? "1 image attached" : `${entry.imageCount} images attached`}
            </div>
          ) : null}
          {/* Actions and the branch chip share one row, so a turn with neither
              hovered nor branched costs no vertical space. */}
          {/* The chip leads: it is always visible, so the hover-only actions
              must not shift it sideways by reserving width ahead of it. */}
          <div className="entry-actions flex items-center gap-2">
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
                  pace={thinkingPace}
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
              {/* Hidden where the row has a margin to put this in. */}
              <span className="meta-inline">
                <EntryMeta entry={entry} />
              </span>
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
        <div className="overflow-hidden rounded-md border border-edge bg-ink-1">
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

/**
 * Before the first turn: what is happening, or what to do next.
 *
 * Opening a workspace starts its agent, so the usual state here is waiting for
 * one to come up. That wait is real — the harness loads its config, its
 * extensions, and its model — and saying so is better than an empty page that
 * looks broken. The button is only for the cases the app will not start on its
 * own: a session that exited, or one whose last start failed.
 */
function EmptyTranscript() {
  const cwd = useAppStore((s) => s.cwd);
  const harness = useAppStore((s) => s.harness);
  const runtime = useAppStore((s) => s.runtime);
  const connecting = useAppStore((s) => s.connecting);
  const startRuntime = useAppStore((s) => s.startRuntime);
  const live = runtime !== null && !runtime.exited;

  if (cwd && connecting) {
    return (
      <div className="flex flex-col items-center gap-3 pt-24 pb-16 text-center">
        <Loader2 size={16} className="animate-spin text-amber-dim" aria-hidden />
        <p className="text-md text-ink-dim">
          Starting {harness} in <span className="font-mono text-ink-text">{projectName(cwd)}</span>…
        </p>
        <p className="max-w-[380px] text-sm text-ink-faint">
          Loading its configuration, extensions, and model. This takes a few seconds.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 pt-24 pb-16 text-center">
      <div className="font-mono text-base text-amber-dim">›_</div>
      <p className="max-w-[400px] text-md text-ink-dim">
        Send a prompt to begin. Answers you do not like can be branched from rather than lost — every
        turn stays in the tree.
      </p>
      {cwd ? <p className="font-mono text-xs text-ink-faint">{cwd}</p> : null}
      {cwd && !live ? (
        <button
          onClick={() => void startRuntime()}
          className="mt-1 rounded-sm border border-amber-dim/60 bg-amber/15 px-3 py-1.5 text-sm text-amber hover:bg-amber/25"
        >
          Start session
        </button>
      ) : null}
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
