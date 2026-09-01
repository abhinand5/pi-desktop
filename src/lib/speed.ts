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

/**
 * One turn's measurement in progress.
 *
 * A turn is one prompt and everything the agent does to answer it, which may be
 * several assistant messages with tool calls between them. That matters for the
 * arithmetic: the gap while a tool runs is not generation, so each message's
 * span is closed and added to a running total rather than measuring end to end
 * across the whole turn. Timing across the gaps would report a rate a third of
 * the real one on any turn that used a tool.
 */
export interface SpeedTracker {
  /** When the prompt was sent. Null between turns. */
  startedAt: number | null;
  /** First output of the turn, for the prompt-processing figure. */
  firstTokenAt: number | null;
  /** First output of the message currently streaming. */
  messageStartAt: number | null;
  lastTokenAt: number | null;
  /** Characters of the message currently streaming. */
  chars: number;
  /** Output tokens of the messages already closed in this turn. */
  tokens: number;
  /** Generation time of the messages already closed, tool gaps excluded. */
  generateMs: number;
  sample: SpeedSample | null;
}

export const emptyTracker: SpeedTracker = {
  startedAt: null,
  firstTokenAt: null,
  messageStartAt: null,
  lastTokenAt: null,
  chars: 0,
  tokens: 0,
  generateMs: 0,
  sample: null,
};

/** A turn began. Everything resets — speed describes one turn, not a session. */
export function beginTurn(now: number): SpeedTracker {
  return { ...emptyTracker, startedAt: now };
}

/** Output arrived. The first call closes out prompt processing. */
export function observeDelta(tracker: SpeedTracker, chars: number, now: number): SpeedTracker {
  // Output before a recorded start (a replayed or resumed turn) is not
  // measurable — timing it against nothing would invent a number.
  if (tracker.startedAt === null) return tracker;
  const next: SpeedTracker = {
    ...tracker,
    firstTokenAt: tracker.firstTokenAt ?? now,
    messageStartAt: tracker.messageStartAt ?? now,
    lastTokenAt: now,
    chars: tracker.chars + chars,
  };
  return { ...next, sample: measure(next, false) };
}

/**
 * One assistant message ended. `outputTokens` is the harness's own count, which
 * replaces the character estimate for that message.
 *
 * The turn may not be over — a tool call means more messages follow — so the
 * figures stay marked live and the message's span is folded into the totals.
 */
export function endMessage(
  tracker: SpeedTracker,
  outputTokens: number | null,
  now: number,
): SpeedTracker {
  if (tracker.startedAt === null) return tracker;
  const closed = closeMessage(tracker, outputTokens, now);
  return { ...closed, sample: measure(closed, false) };
}

/**
 * The turn finished. What comes back is the figure for the whole turn, and the
 * tracker goes inert so the next `agent_start` begins a fresh one — which is
 * what makes a steered or queued follow-up measure as its own turn.
 */
export function settleTurn(tracker: SpeedTracker, now: number): SpeedTracker {
  if (tracker.startedAt === null) return { ...tracker, sample: null };
  const closed = closeMessage(tracker, null, now);
  return { ...closed, startedAt: null, sample: measure(closed, true) };
}

/** Folds the open message's span and tokens into the turn's totals. */
function closeMessage(t: SpeedTracker, outputTokens: number | null, now: number): SpeedTracker {
  if (t.messageStartAt === null && t.chars === 0) return t;
  const lastTokenAt = t.lastTokenAt ?? now;
  const span = t.messageStartAt !== null ? Math.max(0, lastTokenAt - t.messageStartAt) : 0;
  const counted =
    typeof outputTokens === "number" && outputTokens > 0
      ? outputTokens
      : Math.round(t.chars / CHARS_PER_TOKEN);
  return {
    ...t,
    lastTokenAt,
    generateMs: t.generateMs + span,
    tokens: t.tokens + counted,
    chars: 0,
    messageStartAt: null,
  };
}

function measure(t: SpeedTracker, settled: boolean): SpeedSample {
  const promptMs = t.startedAt !== null && t.firstTokenAt !== null ? t.firstTokenAt - t.startedAt : null;

  // The message still streaming, on top of the ones already closed.
  const openSpan =
    t.messageStartAt !== null && t.lastTokenAt !== null ? Math.max(0, t.lastTokenAt - t.messageStartAt) : 0;
  const generateMs = t.generateMs + openSpan;
  const openTokens = t.chars > 0 ? t.chars / CHARS_PER_TOKEN : 0;
  const tokens = t.tokens + openTokens;

  // Under ~120ms the clock resolution dominates and the rate is nonsense.
  const tokensPerSecond = tokens > 0 && generateMs >= 120 ? (tokens * 1000) / generateMs : null;

  return {
    promptMs,
    tokensPerSecond,
    outputTokens: tokens > 0 ? Math.round(tokens) : null,
    generateMs: generateMs > 0 ? generateMs : null,
    live: !settled,
  };
}

/** What every settled turn of a session amounted to. */
export interface SpeedSummary {
  /** Turns that produced a measurable generation rate. */
  turns: number;
  /** Mean and best generation rate across those turns. */
  meanRate: number | null;
  bestRate: number | null;
  /** Median, which a single stalled turn cannot drag around. */
  medianRate: number | null;
  /** Mean and best wait before the first token. */
  meanPromptMs: number | null;
  bestPromptMs: number | null;
  /** Output tokens and generation time totalled over the session. */
  totalTokens: number;
  totalGenerateMs: number;
}

/**
 * Aggregates the settled turns of a session.
 *
 * The mean rate is weighted by generation time rather than by turn, so a
 * two-word answer measured over 200ms does not count as much as a long one —
 * an unweighted mean of per-turn rates flatters short turns badly.
 */
export function summarize(samples: SpeedSample[]): SpeedSummary {
  const rated = samples.filter(
    (s): s is SpeedSample & { tokensPerSecond: number; generateMs: number; outputTokens: number } =>
      s.tokensPerSecond !== null && s.generateMs !== null && s.outputTokens !== null,
  );
  const prompts = samples.map((s) => s.promptMs).filter((ms): ms is number => ms !== null);

  const totalTokens = rated.reduce((n, s) => n + s.outputTokens, 0);
  const totalGenerateMs = rated.reduce((n, s) => n + s.generateMs, 0);
  const rates = rated.map((s) => s.tokensPerSecond).sort((a, b) => a - b);

  return {
    turns: rated.length,
    meanRate: totalGenerateMs > 0 ? (totalTokens * 1000) / totalGenerateMs : null,
    bestRate: rates.length ? rates[rates.length - 1] : null,
    medianRate: rates.length ? median(rates) : null,
    meanPromptMs: prompts.length ? prompts.reduce((a, b) => a + b, 0) / prompts.length : null,
    bestPromptMs: prompts.length ? Math.min(...prompts) : null,
    totalTokens,
    totalGenerateMs,
  };
}

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
