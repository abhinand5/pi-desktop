import { describe, expect, it } from "vitest";
import { beginTurn, emptyTracker, formatDuration, formatRate, observeDelta, settleTurn, summarize } from "./speed";

describe("speed tracking", () => {
  it("measures prompt processing as the wait before the first token", () => {
    let t = beginTurn(1000);
    t = observeDelta(t, 40, 1800);
    expect(t.sample?.promptMs).toBe(800);
  });

  it("reports a live rate while streaming and marks it as an estimate", () => {
    let t = beginTurn(0);
    t = observeDelta(t, 380, 500); // first token at 500ms
    t = observeDelta(t, 380, 1500); // 1s of generation, ~200 chars/token-ish
    const s = t.sample!;
    expect(s.live).toBe(true);
    expect(s.generateMs).toBe(1000);
    // 760 chars / 3.8 = 200 tokens over 1s.
    expect(Math.round(s.tokensPerSecond!)).toBe(200);
    expect(s.outputTokens).toBe(200);
  });

  it("replaces the estimate with the harness's own count when the turn settles", () => {
    let t = beginTurn(0);
    t = observeDelta(t, 1900, 1000); // first token at 1s
    t = observeDelta(t, 1900, 2000); // 1s of generation; estimate would be 1000
    t = settleTurn(t, 500, 2100); // the harness says 500
    const s = t.sample!;
    expect(s.live).toBe(false);
    expect(s.outputTokens).toBe(500);
    expect(s.tokensPerSecond).toBe(500); // 500 tokens over 1s of generation
  });

  it("withholds a rate when only one chunk arrived — there is no window to measure", () => {
    let t = beginTurn(0);
    t = observeDelta(t, 3800, 1000);
    t = settleTurn(t, 500, 2000);
    expect(t.sample?.tokensPerSecond).toBeNull();
    expect(t.sample?.outputTokens).toBe(500);
  });

  it("withholds a rate when the sample is too short to mean anything", () => {
    let t = beginTurn(0);
    t = observeDelta(t, 100, 10);
    t = observeDelta(t, 100, 40); // 30ms of generation
    expect(t.sample?.tokensPerSecond).toBeNull();
  });

  it("measures nothing for a turn it never saw start", () => {
    const t = observeDelta(emptyTracker, 500, 1000);
    expect(t.sample).toBeNull();
    expect(settleTurn(emptyTracker, 100, 1000).sample).toBeNull();
  });

  it("keeps each turn's figures to that turn", () => {
    let t = beginTurn(0);
    t = observeDelta(t, 3800, 1000);
    t = beginTurn(5000);
    expect(t.chars).toBe(0);
    expect(t.sample).toBeNull();
  });
});

describe("formatting", () => {
  it("scales duration units to what is being read", () => {
    expect(formatDuration(340)).toBe("340 ms");
    expect(formatDuration(1240)).toBe("1.2 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(null)).toBe("—");
  });

  it("drops the decimal once the rate is large enough not to need it", () => {
    expect(formatRate(42.36)).toBe("42.4 tok/s");
    expect(formatRate(180.4)).toBe("180 tok/s");
    expect(formatRate(null)).toBe("—");
  });
});

describe("session summary", () => {
  const sample = (tokensPerSecond: number, generateMs: number, promptMs: number) => ({
    promptMs,
    tokensPerSecond,
    generateMs,
    outputTokens: Math.round((tokensPerSecond * generateMs) / 1000),
    live: false,
  });

  it("weights the mean rate by generation time, not by turn", () => {
    // One long slow turn and one blink-length fast one. An unweighted mean of
    // the two rates would claim ~305 tok/s for a session that spent almost all
    // its time at 10.
    const s = summarize([sample(10, 20_000, 500), sample(600, 200, 500)]);
    expect(Math.round(s.meanRate!)).toBe(16);
    expect(s.bestRate).toBe(600);
    expect(s.medianRate).toBe(305);
    expect(s.turns).toBe(2);
  });

  it("keeps prompt waits separate from generation", () => {
    const s = summarize([sample(50, 1000, 200), sample(50, 1000, 800)]);
    expect(s.meanPromptMs).toBe(500);
    expect(s.bestPromptMs).toBe(200);
    expect(s.totalGenerateMs).toBe(2000);
    expect(s.totalTokens).toBe(100);
  });

  it("reports nothing rather than zero when no turn was measurable", () => {
    const s = summarize([{ promptMs: null, tokensPerSecond: null, outputTokens: null, generateMs: null, live: false }]);
    expect(s.turns).toBe(0);
    expect(s.meanRate).toBeNull();
    expect(s.medianRate).toBeNull();
    expect(s.meanPromptMs).toBeNull();
  });
});
