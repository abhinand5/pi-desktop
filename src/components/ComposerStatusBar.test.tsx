import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ComposerStatusBar from "./ComposerStatusBar";
import { useAppStore } from "../lib/agent-store";
import { bridge } from "../lib/bridge";
import type { SpeedSample } from "../lib/speed";

const cwd = "/home/abhinand/dev/g14-llm-configs";

function sample(over: Partial<SpeedSample> = {}): SpeedSample {
  return {
    promptMs: 800,
    tokensPerSecond: 60,
    outputTokens: 900,
    generateMs: 15_000,
    live: false,
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(bridge, "gitStatus").mockResolvedValue({ isRepo: false, branch: null, changed: 0, staged: 0 });
  useAppStore.setState({
    cwd,
    target: null,
    context: null,
    stats: null,
    speed: null,
    speedHistory: [],
  });
});

describe("the throughput readout", () => {
  it("keeps showing the session average during a turn's unmeasurable first moments", () => {
    // A turn under ~120ms of generation has no rate of its own yet. The readout
    // must not vanish and come back once per turn.
    useAppStore.setState({
      speedHistory: [sample()],
      speed: sample({ live: true, tokensPerSecond: null }),
    });

    render(<ComposerStatusBar />);

    expect(screen.getByRole("button", { name: "Throughput, session average" })).toBeTruthy();
  });

  it("says it is showing this turn only when the number really is this turn's", () => {
    useAppStore.setState({
      speedHistory: [sample()],
      speed: sample({ live: true, tokensPerSecond: 92 }),
    });

    render(<ComposerStatusBar />);

    expect(screen.getByRole("button", { name: "Throughput, this turn" })).toBeTruthy();
  });

  it("shows a folder's name rather than its path when there is no branch to show", () => {
    render(<ComposerStatusBar />);

    expect(screen.getByTitle(cwd).textContent).toBe("g14-llm-configs");
  });
});
