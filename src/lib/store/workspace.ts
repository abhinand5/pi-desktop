/**
 * A workspace: one agent, in one folder, on one machine.
 *
 * The app runs several at once — you can leave a turn generating in one, switch
 * to another, and come back to a finished answer. So every per-session fact
 * lives on a workspace rather than on the store, and the store's familiar flat
 * fields (`agent`, `runtime`, `tree`, …) are a read-only *projection* of
 * whichever workspace is active. Writes go through `patchWorkspace`; the
 * projection follows.
 *
 * Runtimes belong to the Rust side and keep running regardless of what the UI
 * is showing, so a background workspace goes on receiving events the whole time.
 */

import { initialState, type AgentState, type ModelInfo, type RuntimeInfo } from "../agent-state";
import type { HarnessCommand, HarnessId, PtyProgram, SessionTree } from "../bridge";
import { emptyTracker, type SpeedSample, type SpeedTracker } from "../speed";
import type { SessionStats, Verdict } from "./types";

/**
 * What a workspace *is*, and so what fills the window when it is in front.
 *
 * A terminal is a workspace kind rather than a separate mode of the app,
 * because the sidebar is already the tab strip: workspaces are grouped by
 * project, keep running when you switch away, survive a restart, and mark
 * themselves when something finishes. A second tab system for terminals would
 * duplicate all of that and make you choose which one you were navigating.
 */
export type WorkspaceKind = "chat" | "terminal";

/** A folder-level workspace shown as one group in the sidebar. */
export interface ProjectWorkspace {
  cwd: string;
  archived: boolean;
}

export interface Workspace {
  id: string;
  kind: WorkspaceKind;
  /** Terminals only: what the pty runs. */
  program: PtyProgram;
  harness: HarnessId;
  /** null = this machine; otherwise an ssh host alias. */
  target: string | null;
  cwd: string;
  /** Session file to resume on the next start. */
  selectedSessionPath: string | null;

  runtime: RuntimeInfo | null;
  agent: AgentState;
  connecting: boolean;
  connectionError: string | null;
  sessionFile: string | null;
  sessionName: string | null;
  verdict: Verdict;
  context: { percent?: number; tokens?: number; contextWindow?: number } | null;
  stats: SessionStats | null;
  bridgeReady: boolean;

  tree: SessionTree | null;
  leafId: string | null;
  treeLoading: boolean;
  treeError: string | null;

  harnessCommands: HarnessCommand[];
  selectedModel: ModelInfo | null;
  thinking: string;
  composerDraft: string | null;

  speedTracker: SpeedTracker;
  speed: SpeedSample | null;
  /** Every settled turn of this session, oldest first, for the averages. */
  speedHistory: SpeedSample[];

  /** A turn settled while you were looking somewhere else. */
  unread: boolean;
}

let counter = 0;

export function createWorkspace(init: {
  harness: HarnessId;
  cwd: string;
  target?: string | null;
  sessionPath?: string | null;
  thinking?: string;
  model?: ModelInfo | null;
  kind?: WorkspaceKind;
  program?: PtyProgram;
}): Workspace {
  counter += 1;
  return {
    id: `ws-${counter}`,
    kind: init.kind ?? "chat",
    program: init.program ?? "shell",
    harness: init.harness,
    target: init.target ?? null,
    cwd: init.cwd,
    selectedSessionPath: init.sessionPath ?? null,
    runtime: null,
    agent: initialState,
    connecting: false,
    connectionError: null,
    sessionFile: null,
    sessionName: null,
    verdict: null,
    context: null,
    stats: null,
    bridgeReady: false,
    tree: null,
    leafId: null,
    treeLoading: false,
    treeError: null,
    harnessCommands: [],
    selectedModel: init.model ?? null,
    thinking: init.thinking ?? "medium",
    composerDraft: null,
    speedTracker: emptyTracker,
    speed: null,
    speedHistory: [],
    unread: false,
  };
}

const SESSION_TITLE_LIMIT = 140;

/** Turns the first user prompt line into the compact label used by /resume. */
export function firstLineTitle(text: string): string {
  const line = text
    .split(/\r?\n/)
    .find((part) => part.trim())
    ?.trim()
    .replace(/\s+/g, " ");
  if (!line) return "";
  const chars = Array.from(line);
  return chars.length > SESSION_TITLE_LIMIT ? `${chars.slice(0, SESSION_TITLE_LIMIT).join("")}…` : line;
}

/** Shown before any project is open, so the flat projection is never undefined. */
export const BLANK: Workspace = createWorkspace({ harness: "omp", cwd: "" });

export function isLive(w: Workspace | null | undefined): boolean {
  return !!w?.runtime && !w.runtime.exited;
}

/**
 * How a workspace reads in the sidebar, under its project's heading.
 *
 * The heading already says which folder this is, so naming the folder again
 * here would print it twice; what distinguishes the rows in a group is which
 * *session* each one is on.
 */
export function workspaceTitle(w: Workspace): string {
  if (w.sessionName?.trim()) return w.sessionName.trim();
  const first = w.agent.entries.find((entry) => entry.kind === "user" && entry.text.trim());
  if (first?.kind === "user") {
    const title = firstLineTitle(first.text);
    if (title) return title;
  }
  return w.sessionFile || w.selectedSessionPath ? "untitled session" : "new session";
}

export function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() || cwd || "no folder";
}

/** A session file's name, or its id when the harness never named it. */
export function sessionLabel(s: { name?: string | null; id: string }): string {
  return s.name?.trim() || `untitled · ${s.id.slice(0, 8)}`;
}

/**
 * "3m", "2h", "5d" — how long ago, in the width of a sidebar column.
 *
 * Coarse on purpose: the question a history list answers is "which one was I in
 * yesterday", and a precise timestamp costs more room than it earns. The exact
 * time stays in the row's tooltip.
 */
export function shortAge(timestamp: string | null | undefined): string {
  if (!timestamp) return "";
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

/** The fields the store mirrors from the active workspace. Components read
 *  these directly, so switching workspaces re-points the whole UI at once. */
export interface WorkspaceProjection {
  kind: WorkspaceKind;
  program: PtyProgram;
  harness: HarnessId;
  cwd: string | null;
  target: string | null;
  selectedSessionPath: string | null;
  runtime: RuntimeInfo | null;
  agent: AgentState;
  connecting: boolean;
  connectionError: string | null;
  sessionFile: string | null;
  sessionName: string | null;
  verdict: Verdict;
  context: Workspace["context"];
  stats: SessionStats | null;
  bridgeReady: boolean;
  tree: SessionTree | null;
  leafId: string | null;
  treeLoading: boolean;
  treeError: string | null;
  harnessCommands: HarnessCommand[];
  selectedModel: ModelInfo | null;
  thinking: string;
  composerDraft: string | null;
  speed: SpeedSample | null;
  speedHistory: SpeedSample[];
}

export function project(w: Workspace | null | undefined): WorkspaceProjection {
  const s = w ?? BLANK;
  return {
    kind: s.kind,
    program: s.program,
    harness: s.harness,
    // A blank workspace has no folder; the UI shows its welcome state for that.
    cwd: s.cwd || null,
    target: s.target,
    selectedSessionPath: s.selectedSessionPath,
    runtime: s.runtime,
    agent: s.agent,
    connecting: s.connecting,
    connectionError: s.connectionError,
    sessionFile: s.sessionFile,
    sessionName: s.sessionName,
    verdict: s.verdict,
    context: s.context,
    stats: s.stats,
    bridgeReady: s.bridgeReady,
    tree: s.tree,
    leafId: s.leafId,
    treeLoading: s.treeLoading,
    treeError: s.treeError,
    harnessCommands: s.harnessCommands,
    selectedModel: s.selectedModel,
    thinking: s.thinking,
    composerDraft: s.composerDraft,
    speed: s.speed,
    speedHistory: s.speedHistory,
  };
}
