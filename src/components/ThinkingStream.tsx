import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ThinkingPace } from "../lib/store/types";

/**
 * Reasoning, shown as one live line.
 *
 * Thinking is usually the most interesting thing happening and the least
 * accessible — folded behind a disclosure nobody opens mid-turn. So while it
 * streams, the tail of it scrolls past on a single line: enough to follow the
 * shape of the reasoning without the transcript being swamped by it. Click to
 * open the whole thing.
 */
export default function ThinkingStream({
  text,
  streaming,
  display,
  pace = "readable",
}: {
  text: string;
  streaming: boolean;
  /** inline = one live line, collapsed = a disclosure, hidden = not shown. */
  display: "inline" | "collapsed" | "hidden";
  pace?: ThinkingPace;
}) {
  const [expanded, setExpanded] = useState(false);
  const inline = display === "inline" && !expanded;
  const visibleText = usePacedText(text, streaming && inline, pace);

  if (display === "hidden" || !text.trim()) return null;

  return (
    // Opaque, and it has to be: the tail's left edge fades into this colour,
    // and a translucent surface made that gradient a grey smear across the text
    // instead of the text dissolving into its own background.
    <div className="rounded-md border border-edge/60 bg-ink-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {expanded ? (
          <ChevronDown size={11} className="shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-ink-faint" />
        )}
        <span
          className={`eyebrow shrink-0 font-mono text-2xs tracking-wider uppercase ${
            streaming ? "text-amber-dim" : "text-ink-faint"
          }`}
        >
          thinking
        </span>
        {inline ? <TailLine text={visibleText} streaming={streaming} /> : null}
      </button>

      {expanded ? (
        <div className="selectable border-t border-line/60 px-3 py-2 text-sm whitespace-pre-wrap text-ink-dim">
          {text}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The tail of the reasoning, scrolled to the right edge as it grows.
 *
 * A real overflowing element rather than a sliced string: the text glides
 * rather than jumping a character at a time, and selecting or resizing shows
 * the true content instead of a truncation.
 */
function TailLine({ text, streaming }: { text: string; streaming: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
  }, [text]);

  return (
    <span className="relative flex min-w-0 flex-1 items-center">
      {/* The left edge fades so the line reads as a window onto a longer
          thought, not as a sentence that begins mid-word. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-ink-1 to-transparent"
      />
      <span
        ref={ref}
        className="min-w-0 flex-1 overflow-x-hidden text-sm whitespace-nowrap text-ink-faint italic"
      >
        {text.replace(/\s+/g, " ")}
      </span>
      {streaming ? <span className="ml-1 shrink-0 text-amber-dim">▍</span> : null}
    </span>
  );
}

const PACE_TICK_MS = 50;
/** Characters a second the line glides at when the model is slower than this. */
const PACE_FLOOR: Record<Exclude<ThinkingPace, "instant">, number> = {
  readable: 48,
  slow: 24,
};
/** The longest the preview may trail the real stream. */
const MAX_LAG_MS = 1_500;

/**
 * Reveals streamed thinking on its own clock rather than on the harness's
 * delta cadence, so the line glides instead of lurching a chunk at a time.
 *
 * The floor rate is only a floor: a model that reasons faster than it would
 * pull the preview ever further behind, so the reveal accelerates with the
 * backlog and the line stays within `MAX_LAG_MS` of the real tail. Pacing
 * decides how smoothly the text moves, never how current it is. Text that has
 * settled — the turn ended, the disclosure opened, the pace is "instant" —
 * flushes whole.
 */
function usePacedText(text: string, active: boolean, pace: ThinkingPace): string {
  const paced = active && pace !== "instant";
  const sourceRef = useRef(text);
  const cursorRef = useRef(paced ? 0 : text.length);
  const [visible, setVisible] = useState(paced ? "" : text);

  useEffect(() => {
    sourceRef.current = text;
    if (!paced) {
      cursorRef.current = text.length;
      setVisible(text);
    }
  }, [text, paced]);

  useEffect(() => {
    if (!paced) return;
    const floor = PACE_FLOOR[pace as Exclude<ThinkingPace, "instant">];
    // Held on the effect rather than in the state updater: an updater has to
    // stay pure, and React may call it more than once per commit.
    let carry = 0;

    const timer = window.setInterval(() => {
      const target = sourceRef.current;
      // A fresh thinking block replaces the text outright.
      const cursor = Math.min(cursorRef.current, target.length);
      if (cursor >= target.length) {
        cursorRef.current = cursor;
        return;
      }
      const backlog = target.length - cursor;
      const rate = Math.max(floor, (backlog * 1_000) / MAX_LAG_MS);
      carry += (rate * PACE_TICK_MS) / 1_000;
      const step = Math.floor(carry);
      if (step < 1) return;
      carry -= step;
      cursorRef.current = Math.min(target.length, cursor + step);
      setVisible(target.slice(0, cursorRef.current));
    }, PACE_TICK_MS);

    return () => window.clearInterval(timer);
  }, [paced, pace]);

  return visible;
}
