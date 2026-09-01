import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ThinkingStream from "./ThinkingStream";

const source =
  "I should inspect the rail and the settings boundary together before choosing the safest fix.";

function liveText(): string {
  const button = document.querySelector("button");
  if (!button) throw new Error("Thinking disclosure did not render");
  return button.querySelector(".italic")?.textContent?.replace(/▍/g, "") ?? "";
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ThinkingStream", () => {
  it("does not dump a full fast thinking stream into the live preview", () => {
    vi.useFakeTimers();
    render(<ThinkingStream text={source} streaming display="inline" />);

    expect(liveText()).toBe("");

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(liveText().length).toBeGreaterThan(0);
    expect(liveText().length).toBeLessThan(source.length);
  });

  it("catches up to a fast stream instead of falling further behind it", () => {
    vi.useFakeTimers();
    // More reasoning than any fixed reveal rate could keep level with.
    const long = source.repeat(45);
    render(<ThinkingStream text={long} streaming display="inline" />);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    // The floor rate alone would have shown under 100 characters by now, and
    // the preview would be minutes behind by the end of the turn.
    expect(liveText().length).toBeGreaterThan(1_000);
    expect(liveText()).toBe(long.slice(0, liveText().length));
  });
});
