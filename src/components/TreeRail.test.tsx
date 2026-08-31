import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import TreeRail from "./TreeRail";
import { useAppStore } from "../lib/agent-store";
import { defaultSettings } from "../lib/store/types";

const emptyTree = { nodes: [], truncated: false };

function installLocalStorage(): Storage {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  return storage;
}

beforeEach(() => {
  const storage = installLocalStorage();
  storage.removeItem("pi-desktop.settings");
  useAppStore.setState({
    openPanel: "tree",
    tree: emptyTree,
    treeLoading: false,
    treeError: null,
    bridgeReady: true,
    selectedNodeId: null,
    settings: { ...defaultSettings, summarizeOnJump: true },
  });
});

afterEach(() => {
  useAppStore.setState({ openPanel: null, settings: defaultSettings });
});

describe("TreeRail", () => {
  it("projects summarize-on-jump from Settings and writes back to it", () => {
    render(<TreeRail />);

    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!checkbox) throw new Error("TreeRail checkbox did not render");
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);

    expect(useAppStore.getState().settings.summarizeOnJump).toBe(false);
    expect(window.localStorage.getItem("pi-desktop.settings")).toContain('"summarizeOnJump":false');
  });
});
