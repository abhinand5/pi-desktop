import { beforeEach, describe, expect, it } from "vitest";
import { createUiSlice } from "./ui-slice";
import type { AppStore } from "./types";

const SIDEBAR_KEY = "pi-desktop.sidebar-open";

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
  const set: Parameters<typeof createUiSlice>[0] = (partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    Object.assign(state, next);
  };
  const get: Parameters<typeof createUiSlice>[1] = () => state;
  const slice = createUiSlice(set, get);
  Object.assign(state, slice);
  return { state, slice };
}

describe("ui slice", () => {
  beforeEach(() => {
    const storage = installLocalStorage();
    storage.removeItem(SIDEBAR_KEY);
  });

  it("persists sidebar visibility and restores it in a new slice", () => {
    const first = makeSlice();

    expect(first.slice.sidebarOpen).toBe(true);
    first.slice.toggleSidebar();
    expect(first.state.sidebarOpen).toBe(false);
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("false");

    const second = makeSlice();
    expect(second.slice.sidebarOpen).toBe(false);
  });
});
