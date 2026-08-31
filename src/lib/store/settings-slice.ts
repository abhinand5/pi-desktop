/** Preferences, persisted to localStorage so they survive a restart. */

import { defaultSettings, type Settings, type SettingsSlice, type SliceOf } from "./types";

const KEY = "pi-desktop.settings";

export function loadSettings(): Settings {
  if (typeof window === "undefined") return defaultSettings;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Merged over the defaults, so a setting added in a later version arrives
    // with its default rather than as undefined.
    return { ...defaultSettings, ...parsed };
  } catch {
    return defaultSettings;
  }
}

function persist(settings: Settings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* a full or blocked store is not worth failing a click over */
  }
}

export const createSettingsSlice: SliceOf<SettingsSlice> = (set, get) => ({
  settings: loadSettings(),

  setSetting(key, value) {
    const settings = { ...get().settings, [key]: value };
    set({ settings });
    persist(settings);
  },

  resetSettings() {
    set({ settings: defaultSettings });
    persist(defaultSettings);
  },
});
