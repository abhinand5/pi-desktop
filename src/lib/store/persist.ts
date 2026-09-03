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

import type { HarnessId, PtyProgram } from "../bridge";
import {
  createWorkspace,
  isScratchWorkspacePath,
  projectKey,
  type ProjectKind,
  type ProjectWorkspace,
  type Workspace,
  type WorkspaceKind,
} from "./workspace";

const KEY = "pi-desktop.workspaces";
/** Enough to be a memory, not so many that a restart takes a visible moment. */
const MAX = 24;

interface StoredWorkspace {
  cwd: string;
  harness: HarnessId;
  target: string | null;
  sessionPath: string | null;
  sessionName: string | null;
  kind?: WorkspaceKind;
  program?: PtyProgram;
}

interface StoredProject {
  cwd: string;
  archived: boolean;
  kind?: ProjectKind;
  /** Absent in stores written before projects knew which machine they were on. */
  target?: string | null;
}

interface Stored {
  version: 1 | 2;
  workspaces: StoredWorkspace[];
  /** Index into `workspaces` of the one that was in front. */
  active: number;
  /** Project workspaces, including archived ones with no open tabs. */
  projects?: StoredProject[];
}

export interface RestoredWorkspaces {
  projects: Record<string, ProjectWorkspace>;
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
    if ((parsed?.version !== 1 && parsed?.version !== 2) || !Array.isArray(parsed.workspaces)) return null;

    /*
     * Version 1 let a workspace's machine be changed after it was created.
     *
     * Switching machines re-pointed the workspace in front of you: `target`
     * became the host while `cwd` stayed whatever local path it already had.
     * The result is a workspace that claims to live in, say, this machine's
     * scratch directory *on a build box* — a path that does not exist there, so
     * a session exits at once and a terminal opens with `cd: no such file or
     * directory` and a closed connection.
     *
     * A remote v1 workspace cannot be told apart from a corrupted one: both are
     * a host plus a path, and only the far side knows whether the path is real.
     * So they are dropped on the way in. Local workspaces — every workspace,
     * for anyone who never added a host — are untouched, and a dropped one
     * costs a tab, never a session: the files are still on the machine that has
     * them, and History still lists them.
     */
    const dropRepointed = parsed.version === 1;

    const projects: Record<string, ProjectWorkspace> = {};
    for (const stored of parsed.projects ?? []) {
      if (!stored?.cwd) continue;
      // Same reasoning as the workspaces below: a v1 project that names a host
      // may name a path that only ever existed on this machine, and keeping it
      // would leave a group in the rail whose every action fails on the far side.
      if (dropRepointed && stored.target) continue;
      // An older store has no target, and everything in it was local: that is
      // the only machine the app could put a project on at the time.
      const target = stored.target ?? null;
      projects[projectKey(target, stored.cwd)] = {
        cwd: stored.cwd,
        target,
        archived: stored.archived === true,
        kind: stored.kind === "scratch" ? "scratch" : "folder",
      };
    }

    const workspaces: Record<string, Workspace> = {};
    const workspaceOrder: string[] = [];
    for (const stored of parsed.workspaces) {
      if (dropRepointed && stored?.target) continue;
      if (!stored?.cwd || (stored.harness !== "pi" && stored.harness !== "omp")) continue;
      const w = createWorkspace({
        harness: stored.harness,
        cwd: stored.cwd,
        target: stored.target ?? null,
        sessionPath: stored.sessionPath ?? null,
        // A terminal comes back as an empty terminal, not a dead one: the
        // scrollback belonged to a process that no longer exists, and the
        // folder is the part worth keeping.
        kind: stored.kind === "terminal" ? "terminal" : "chat",
        program: stored.program,
      });
      w.sessionName = stored.sessionName ?? null;
      workspaces[w.id] = w;
      workspaceOrder.push(w.id);
      // Version-one stores have no project list; derive active projects from
      // their remembered session tabs during the migration.
      const key = projectKey(w.target, w.cwd);
      if (!projects[key]) {
        projects[key] = {
          cwd: w.cwd,
          target: w.target,
          archived: false,
          kind: isScratchWorkspacePath(w.cwd) ? "scratch" : "folder",
        };
      }
    }
    if (!workspaceOrder.length && !Object.keys(projects).length) return null;

    const active = workspaceOrder.length ? workspaceOrder[parsed.active] ?? workspaceOrder[0] : null;
    return { projects, workspaces, workspaceOrder, activeWorkspaceId: active };
  } catch {
    return null;
  }
}

export function saveWorkspaces(state: RestoredWorkspaces): void {
  if (typeof window === "undefined") return;
  const order = state.workspaceOrder.slice(0, MAX);
  const stored: Stored = {
    version: 2,
    projects: Object.values(state.projects)
      .filter((project) => project.cwd)
      .map((project) => ({
        cwd: project.cwd,
        target: project.target,
        archived: project.archived,
        kind: project.kind,
      })),
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
          kind: w.kind,
          program: w.program,
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
