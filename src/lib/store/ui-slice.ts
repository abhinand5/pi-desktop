/** Routing, panels, the sidebar, and the small pieces of shared view state. */

import { patchWorkspace } from "./runtime-slice";
import type { PanelId, SliceOf, UiSlice } from "./types";

const SIDEBAR_KEY = "pi-desktop.sidebar-open";

function loadSidebarOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_KEY);
    return raw === null || raw === "true";
  } catch {
    return true;
  }
}

function persistSidebarOpen(open: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, String(open));
  } catch {
    /* a full or blocked store is not worth failing a click over */
  }
}

export const createUiSlice: SliceOf<UiSlice> = (set, get) => ({
  route: "chat",
  openPanel: null,
  commandPaletteOpen: false,
  showAddHost: false,
  sidebarOpen: loadSidebarOpen(),
  selectedNodeId: null,
  notice: null,

  setRoute(route) {
    set({ route });
    // Pages load what they show on arrival rather than polling in the back.
    if (route === "usage") void get().loadUsage();
  },

  setPanel(panel) {
    set({ openPanel: panel });
    if (panel === "providers") void get().loadProviders();
    if (panel === "status") void get().refreshStats();
    if (panel === "tree") void get().refreshTree();
    // Panels belong to the conversation, so opening one leaves any other page.
    if (panel) set({ route: "chat" });
  },

  togglePanel(panel: PanelId) {
    get().setPanel(get().openPanel === panel ? null : panel);
  },

  setCommandPaletteOpen(open) {
    set({ commandPaletteOpen: open });
  },

  setShowAddHost(open) {
    set({ showAddHost: open });
  },

  toggleSidebar() {
    const sidebarOpen = !get().sidebarOpen;
    set({ sidebarOpen });
    persistSidebarOpen(sidebarOpen);
  },

  setComposerDraft(text) {
    const id = get().activeWorkspaceId;
    if (id) patchWorkspace(set, get, id, { composerDraft: text });
  },

  setSelectedNode(id) {
    set({ selectedNodeId: id });
  },

  setNotice(text) {
    set({ notice: text });
  },
});
