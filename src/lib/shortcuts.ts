/**
 * Window-level keyboard shortcuts.
 *
 * Everything reachable by mouse should be reachable by keyboard; the app
 * previously bound only the palette and Escape.
 */

export interface Shortcut {
  id: string;
  keys: string;
  label: string;
  match: (e: KeyboardEvent) => boolean;
}

const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;
const key = (e: KeyboardEvent, k: string) => e.key.toLowerCase() === k;

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", keys: "⌘K", label: "Command palette", match: (e) => mod(e) && key(e, "k") },
  { id: "tree", keys: "⌘T", label: "Conversation tree", match: (e) => mod(e) && key(e, "t") },
  { id: "status", keys: "⌘I", label: "Session status", match: (e) => mod(e) && key(e, "i") },
  { id: "terminal", keys: "⌘J", label: "Terminal", match: (e) => mod(e) && key(e, "j") },
  { id: "new", keys: "⌘N", label: "New session", match: (e) => mod(e) && key(e, "n") },
  { id: "sidebar", keys: "⌘B", label: "Show or hide the sidebar", match: (e) => mod(e) && key(e, "b") },
  { id: "settings", keys: "⌘,", label: "Settings", match: (e) => mod(e) && e.key === "," },
  {
    id: "copy-last",
    keys: "⌘⇧C",
    label: "Copy the last response",
    match: (e) => mod(e) && e.shiftKey && key(e, "c"),
  },
  { id: "abort", keys: "Esc", label: "Stop the running turn", match: (e) => key(e, "escape") },
];

/** True when focus is somewhere that owns its own key handling. */
export function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}
