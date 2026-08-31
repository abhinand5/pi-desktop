import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

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
}: {
  text: string;
  streaming: boolean;
  /** inline = one live line, collapsed = a disclosure, hidden = not shown. */
  display: "inline" | "collapsed" | "hidden";
}) {
  const [expanded, setExpanded] = useState(false);

  if (display === "hidden" || !text.trim()) return null;
  const inline = display === "inline" && !expanded;

  return (
    <div className="rounded-md border border-line/60 bg-ink-1/40">
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
          className={`shrink-0 font-mono text-2xs tracking-wider uppercase ${
            streaming ? "text-amber-dim" : "text-ink-faint"
          }`}
        >
          thinking
        </span>
        {inline ? <TailLine text={text} streaming={streaming} /> : null}
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
