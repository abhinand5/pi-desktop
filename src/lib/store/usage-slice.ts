/** Aggregate usage, read from the harness's session files on demand. */

import { bridge } from "../bridge";
import type { SliceOf, UsageSlice } from "./types";

const WINDOW_DAYS: Record<string, number | null> = { all: null, "30d": 30, "7d": 7 };

export const createUsageSlice: SliceOf<UsageSlice> = (set, get) => ({
  usage: null,
  usageWindow: "all",
  usageLoading: false,
  usageError: null,

  setUsageWindow(window) {
    set({ usageWindow: window });
    void get().loadUsage();
  },

  async loadUsage() {
    set({ usageLoading: true, usageError: null });
    try {
      const report = await bridge.usageReport(get().harness, WINDOW_DAYS[get().usageWindow] ?? null);
      set({ usage: report, usageLoading: false });
    } catch (e) {
      set({ usageLoading: false, usageError: String((e as Error)?.message ?? e) });
    }
  },
});
