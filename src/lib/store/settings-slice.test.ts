import { beforeEach, describe, expect, it } from "vitest";
import { createSettingsSlice } from "./settings-slice";
import type { AppStore } from "./types";

const SETTINGS_KEY = "pi-desktop.settings";

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

function makeSlice() {
  const state = {} as AppStore;
  const set: Parameters<typeof createSettingsSlice>[0] = (partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    Object.assign(state, next);
  };
  const get: Parameters<typeof createSettingsSlice>[1] = () => state;
  const slice = createSettingsSlice(set, get);
  Object.assign(state, slice);
  return { state, slice };
}

describe("settings slice", () => {
  beforeEach(() => {
    installLocalStorage().removeItem(SETTINGS_KEY);
  });

  it("defaults thinking to readable and persists a changed pace", () => {
    const first = makeSlice();

    expect(first.slice.settings.thinkingPace).toBe("readable");
    first.slice.setSetting("thinkingPace", "slow");
    expect(first.state.settings.thinkingPace).toBe("slow");

    const second = makeSlice();
    expect(second.slice.settings.thinkingPace).toBe("slow");
  });
});

describe("appearance", () => {
  it("puts the palette on the root, and marks a light theme for the syntax colours", () => {
    const { slice } = makeSlice();

    // The default palette carries an attribute of its own so the settings page
    // can paint a swatch in it while another theme is active.
    expect(document.documentElement.getAttribute("data-theme")).toBe("phosphor");
    expect(document.documentElement.getAttribute("data-appearance")).toBe("dark");

    slice.setSetting("theme", "paper");
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper");
    expect(document.documentElement.getAttribute("data-appearance")).toBe("light");

    slice.setSetting("glass", true);
    expect(document.documentElement.getAttribute("data-glass")).toBe("on");
    slice.setSetting("glass", false);
    expect(document.documentElement.hasAttribute("data-glass")).toBe(false);
  });
});
