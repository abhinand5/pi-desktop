/**
 * Throughput measurement for a turn.
 *
 * Two numbers matter and they measure different things:
 *
 * - **Prompt processing** is the wait before the first token — the model
 *   reading everything you have said so far. It grows with context, and it is
 *   what makes a long session feel slow to start.
 * - **Generation speed** is tokens per second once text is actually flowing.
 *
 * The live figure is an estimate: harnesses report token counts only when the
 * message ends, so while streaming we count characters and divide. At
 * `message_end` the real count replaces the estimate, so the number you are
 * left looking at is exact.
 */

/** Characters per token, averaged over English prose and code. Only used
 *  while streaming; the settled figure uses the harness's own count. */
const CHARS_PER_TOKEN = 3.8;

export interface SpeedSample {
  /** Wall-clock ms from sending the prompt to the first token of output. */
  promptMs: number | null;
  /** Tokens per second of generated output. */
  tokensPerSecond: number | null;
  /** Output tokens: estimated while streaming, exact once settled. */
  outputTokens: number | null;
  /** Time spent generating, excluding the prompt-processing wait. */
  generateMs: number | null;
  /** True while the figures are still estimates. */
  live: boolean;
}

export interface SpeedTracker {
  startedAt: number | null;
  firstTokenAt: number | null;
  lastTokenAt: number | null;
  chars: number;
  sample: SpeedSample | null;
}

export const emptyTracker: SpeedTracker = {
  startedAt: null,
  firstTokenAt: null,
  lastTokenAt: null,
  chars: 0,
  sample: null,
};

/** A turn began. Everything resets — speed describes one turn, not a session. */
export function beginTurn(now: number): SpeedTracker {
  return { startedAt: now, firstTokenAt: null, lastTokenAt: null, chars: 0, sample: null };
}

/** Output arrived. The first call closes out prompt processing. */
export function observeDelta(tracker: SpeedTracker, chars: number, now: number): SpeedTracker {
  // Output before a recorded start (a replayed or resumed turn) is not
  // measurable — timing it against nothing would invent a number.
  if (tracker.startedAt === null) return tracker;
  const firstTokenAt = tracker.firstTokenAt ?? now;
  const next: SpeedTracker = {
    ...tracker,
    firstTokenAt,
    lastTokenAt: now,
    chars: tracker.chars + chars,
  };
  return { ...next, sample: measure(next, false) };
}

/**
 * The turn finished. `outputTokens` is the harness's own count, which replaces
 * the character estimate.
 */
export function settleTurn(
  tracker: SpeedTracker,
  outputTokens: number | null,
  now: number,
): SpeedTracker {
  if (tracker.startedAt === null) return { ...tracker, sample: null };
  const next: SpeedTracker = { ...tracker, lastTokenAt: tracker.lastTokenAt ?? now };
  return { ...next, sample: measure(next, true, outputTokens) };
}

function measure(t: SpeedTracker, settled: boolean, outputTokens?: number | null): SpeedSample {
  const promptMs = t.startedAt !== null && t.firstTokenAt !== null ? t.firstTokenAt - t.startedAt : null;
  const generateMs = t.firstTokenAt !== null && t.lastTokenAt !== null ? t.lastTokenAt - t.firstTokenAt : null;

  const tokens =
    settled && typeof outputTokens === "number" && outputTokens > 0
      ? outputTokens
      : t.chars > 0
        ? Math.round(t.chars / CHARS_PER_TOKEN)
        : null;

  // Under ~120ms the clock resolution dominates and the rate is nonsense.
  const tokensPerSecond =
    tokens !== null && generateMs !== null && generateMs >= 120 ? (tokens * 1000) / generateMs : null;

  return {
    promptMs,
    tokensPerSecond,
    outputTokens: tokens,
    generateMs,
    live: !settled,
  };
}

/** "1.2 s" / "340 ms" — a duration read at a glance. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

export function formatRate(tps: number | null): string {
  if (tps === null) return "—";
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}
