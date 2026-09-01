/**
 * Open workspaces, remembered across restarts.
 *
 * Only the facts that identify a workspace are stored — folder, agent, machine,
 * and the session it was last on. Everything else (the runtime, the transcript,
 * the tree, the speed figures) belongs to a live process and is deliberately
 * not persisted: restoring it would be showing you a conversation that is no
 * longer attached to anything.
 *
 * So a restored workspace comes back idle, pointed at its last session. Opening
 * it resumes that session from the harness's own file, which is the only copy
 * that was ever authoritative.
 */

import type { HarnessId } from "../bridge";
import { createWorkspace, type Workspace } from "./workspace";

const KEY = "pi-desktop.workspaces";
/** Enough to be a memory, not so many that a restart takes a visible moment. */
const MAX = 24;

interface StoredWorkspace {
  cwd: string;
  harness: HarnessId;
  target: string | null;
  sessionPath: string | null;
  sessionName: string | null;
}

interface Stored {
  version: 1;
  workspaces: StoredWorkspace[];
  /** Index into `workspaces` of the one that was in front. */
  active: number;
}

export interface RestoredWorkspaces {
  workspaces: Record<string, Workspace>;
  workspaceOrder: string[];
  activeWorkspaceId: string | null;
}

export function loadWorkspaces(): RestoredWorkspaces | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    if (parsed?.version !== 1 || !Array.isArray(parsed.workspaces)) return null;

    const workspaces: Record<string, Workspace> = {};
    const workspaceOrder: string[] = [];
    for (const stored of parsed.workspaces) {
      if (!stored?.cwd || (stored.harness !== "pi" && stored.harness !== "omp")) continue;
      const w = createWorkspace({
        harness: stored.harness,
        cwd: stored.cwd,
        target: stored.target ?? null,
        sessionPath: stored.sessionPath ?? null,
      });
      w.sessionName = stored.sessionName ?? null;
      workspaces[w.id] = w;
      workspaceOrder.push(w.id);
    }
    if (!workspaceOrder.length) return null;

    const active = workspaceOrder[parsed.active] ?? workspaceOrder[0];
    return { workspaces, workspaceOrder, activeWorkspaceId: active };
  } catch {
    return null;
  }
}

export function saveWorkspaces(state: RestoredWorkspaces): void {
  if (typeof window === "undefined") return;
  const order = state.workspaceOrder.slice(0, MAX);
  const stored: Stored = {
    version: 1,
    workspaces: order.flatMap((id) => {
      const w = state.workspaces[id];
      if (!w?.cwd) return [];
      return [
        {
          cwd: w.cwd,
          harness: w.harness,
          target: w.target,
          // The file the harness actually wrote is the better pointer; the
          // selection is only what we asked for.
          sessionPath: w.sessionFile ?? w.selectedSessionPath,
          sessionName: w.sessionName,
        },
      ];
    }),
    active: Math.max(0, order.indexOf(state.activeWorkspaceId ?? "")),
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    /* a full or blocked store is not worth failing a click over */
  }
}
