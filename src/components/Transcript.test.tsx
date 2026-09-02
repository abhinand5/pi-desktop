import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Transcript from "./Transcript";
import { useAppStore } from "../lib/agent-store";
import { initialState, type Entry } from "../lib/agent-state";
import { defaultSettings } from "../lib/store/types";

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function setAgent(entries: Entry[], streaming = false) {
  useAppStore.setState({
    cwd: "/tmp/pi-desktop",
    agent: {
      ...initialState,
      entries,
      streaming,
      seq: entries.at(-1)?.seq ?? 0,
    },
    settings: { ...defaultSettings, autoScroll: true, thinkingDisplay: "hidden" },
  });
}

function transcriptRoot(): HTMLDivElement {
  const root = document.querySelector<HTMLDivElement>("[data-transcript]");
  if (!root) throw new Error("Transcript scroll root did not render");
  return root;
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  setAgent([{ kind: "user", seq: 1, text: "first prompt" }]);
});

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  useAppStore.setState({ cwd: null, agent: initialState, settings: defaultSettings });
});

describe("Transcript", () => {
  it("keeps the latest generated turn at the viewport bottom", () => {
    render(<Transcript />);
    const root = transcriptRoot();
    let scrollHeight = 1_000;
    Object.defineProperties(root, {
      clientHeight: { configurable: true, get: () => 600 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    act(() => {
      setAgent([
        { kind: "user", seq: 1, text: "first prompt" },
        { kind: "assistant", seq: 2, blocks: [{ kind: "text", text: "new answer" }], streaming: true },
      ], true);
    });

    expect(root.scrollTop).toBe(400);

    scrollHeight = 1_300;
    act(() => {
      setAgent([
        { kind: "user", seq: 1, text: "first prompt" },
        { kind: "assistant", seq: 2, blocks: [{ kind: "text", text: "new answer with more output" }], streaming: true },
      ], true);
    });

    expect(root.scrollTop).toBe(700);
  });

  it("stops following after the user scrolls away", () => {
    render(<Transcript />);
    const root = transcriptRoot();
    let scrollHeight = 1_000;
    Object.defineProperties(root, {
      clientHeight: { configurable: true, get: () => 600 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    act(() => {
      setAgent([
        { kind: "user", seq: 1, text: "first prompt" },
        { kind: "assistant", seq: 2, blocks: [{ kind: "text", text: "new answer" }], streaming: true },
      ], true);
    });
    // No gesture event: scrolling up is what detaches the view, so the
    // keyboard and the scrollbar have to work as well as the wheel does.
    root.scrollTop = 200;
    fireEvent.scroll(root);
    scrollHeight = 1_300;
    act(() => {
      setAgent([
        { kind: "user", seq: 1, text: "first prompt" },
        { kind: "assistant", seq: 2, blocks: [{ kind: "text", text: "new answer with more output" }], streaming: true },
      ], true);
    });

    expect(root.scrollTop).toBe(200);
  });

  it("shows an image marker on user turns that included attachments", () => {
    act(() => {
      setAgent([{ kind: "user", seq: 1, text: "identify this", imageCount: 1 }]);
    });
    render(<Transcript />);

    expect(screen.getByLabelText("1 image attached")).toHaveTextContent("1 image attached");
  });
});
