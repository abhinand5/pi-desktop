import { beforeEach, describe, expect, it } from "vitest";
import { forgetSpeedHistory, loadSpeedHistory, saveSpeedHistory } from "./speed-history";
import type { SpeedSample } from "../speed";

function installLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => void values.set(k, v),
      removeItem: (k: string) => void values.delete(k),
    } as unknown as Storage,
  });
}

const sample = (rate: number): SpeedSample => ({
  promptMs: 500,
  tokensPerSecond: rate,
  outputTokens: rate,
  generateMs: 1000,
  live: false,
});

describe("remembered throughput", () => {
  beforeEach(installLocalStorage);

  it("gives a session its own turns back, and no one else's", () => {
    saveSpeedHistory("/s/a.jsonl", [sample(100), sample(200)]);
    saveSpeedHistory("/s/b.jsonl", [sample(50)]);

    expect(loadSpeedHistory("/s/a.jsonl").map((s) => s.tokensPerSecond)).toEqual([100, 200]);
    expect(loadSpeedHistory("/s/b.jsonl").map((s) => s.tokensPerSecond)).toEqual([50]);
    // A session never measured here starts empty rather than borrowing.
    expect(loadSpeedHistory("/s/never-seen.jsonl")).toEqual([]);
    expect(loadSpeedHistory(null)).toEqual([]);
  });

  it("keeps the most recent turns of a long session", () => {
    saveSpeedHistory("/s/a.jsonl", Array.from({ length: 400 }, (_, i) => sample(i)));
    const back = loadSpeedHistory("/s/a.jsonl");
    expect(back).toHaveLength(300);
    expect(back.at(-1)?.tokensPerSecond).toBe(399);
  });

  it("drops the sessions untouched longest when too many pile up", () => {
    for (let i = 0; i < 45; i++) saveSpeedHistory(`/s/${i}.jsonl`, [sample(i)]);
    // The first ones written are the ones let go.
    expect(loadSpeedHistory("/s/0.jsonl")).toEqual([]);
    expect(loadSpeedHistory("/s/44.jsonl")).toHaveLength(1);
  });

  it("forgets a session whose file was deleted", () => {
    saveSpeedHistory("/s/a.jsonl", [sample(100)]);
    forgetSpeedHistory("/s/a.jsonl");
    expect(loadSpeedHistory("/s/a.jsonl")).toEqual([]);
  });

  it("returns nothing rather than throwing when the store is junk", () => {
    window.localStorage.setItem("pi-desktop.speed", "{not json");
    expect(loadSpeedHistory("/s/a.jsonl")).toEqual([]);
  });
});
