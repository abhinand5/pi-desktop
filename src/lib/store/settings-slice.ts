/** Preferences, persisted to localStorage so they survive a restart. */

import { defaultSettings, THEMES, type Settings, type SettingsSlice, type SliceOf } from "./types";

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

/**
 * Puts the palette on the document root.
 *
 * Every colour in the app resolves through a custom property, so this one
 * attribute is the whole theme switch — no component re-renders and nothing has
 * to be told. The default palette is the bare `:root` block, so it carries no
 * attribute at all.
 */
export function applyAppearance(settings: Settings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // A palette that has since been removed would otherwise leave the attribute
  // pointing at a block that no longer exists, and every colour would fall
  // through to the compiled defaults — readable, but not what anyone chose.
  const theme = THEMES.some((t) => t.id === settings.theme) ? settings.theme : defaultSettings.theme;
  root.setAttribute("data-theme", theme);
  const chosen = THEMES.find((t) => t.id === theme);
  // Syntax highlighting carries both light and dark token colours at once and
  // reads this to pick, so it follows a theme change with no re-highlighting.
  const light = chosen?.light ?? false;
  root.setAttribute("data-appearance", light ? "light" : "dark");
  // Comfortable is the authored spacing, so it carries no attribute — the same
  // reason the default palette carries none.
  if (settings.density === "compact") root.setAttribute("data-density", "compact");
  else root.removeAttribute("data-density");
  root.style.colorScheme = light ? "light" : "dark";
  if (settings.glass) root.setAttribute("data-glass", "on");
  else root.removeAttribute("data-glass");
  // Set as a property override rather than passed to each terminal: the
  // terminals read the computed value, so this reaches the ones already open
  // as well as the next one.
  if (settings.terminalFont.trim()) {
    root.style.setProperty("--font-terminal", `${settings.terminalFont.trim()}, ui-monospace, monospace`);
  } else {
    root.style.removeProperty("--font-terminal");
  }
}

export const createSettingsSlice: SliceOf<SettingsSlice> = (set, get) => {
  const initial = loadSettings();
  applyAppearance(initial);

  return {
    settings: initial,

    setSetting(key, value) {
      const settings = { ...get().settings, [key]: value };
      set({ settings });
      persist(settings);
      applyAppearance(settings);
    },

    resetSettings() {
      set({ settings: defaultSettings });
      persist(defaultSettings);
      applyAppearance(defaultSettings);
    },
  };
};
