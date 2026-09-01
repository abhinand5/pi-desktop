/**
 * Workspace lifecycle and everything that talks to a live agent.
 *
 * Several workspaces run at once. Each owns its runtime, transcript, tree, and
 * speed figures; the store's flat fields are a projection of whichever one is
 * active, so switching is a re-point rather than a reload and a turn left
 * generating keeps generating.
 */

import { applyEvent } from "../agent-reducer";
import { initialState, type HarnessEvent, type ModelInfo } from "../agent-state";
import { bridge, rpc, type BridgeEvent, type ImageAttachment } from "../bridge";
import { describeRuntimeError } from "../errors";
import { emptyTracker } from "../speed";
import { cancelBridgeCalls } from "./bridge-rpc";
import { loadWorkspaces, saveWorkspaces } from "./persist";
import { loadSpeedHistory } from "./speed-history";
import type { AppStore, BashResult, RuntimeSlice, SessionStats, SliceOf } from "./types";
import { closeTerminal } from "../terminals";
import { BLANK, createWorkspace, project, type Workspace } from "./workspace";

/** Unwraps `{ data }` from a correlated RPC response. */
function data<T>(response: unknown): T | undefined {
  return (response as { data?: T } | undefined)?.data;
}

/** The parts of `get_state` the desktop mirrors. Both harnesses answer it. */
interface HarnessState {
  sessionFile?: string;
  sessionName?: string;
  thinkingLevel?: string;
  model?: {
    id?: string;
    name?: string;
    provider?: string;
    api?: string;
    baseUrl?: string | null;
    reasoning?: boolean;
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
    thinking?: { efforts?: string[] };
  };
}

/**
 * The harness's current model as a catalog entry.
 *
 * Matching the catalog is preferred — it carries the normalized fields the
 * pickers read — but `get_state` answers before `get_available_models` does,
 * and a model can be in play without appearing in the catalog at all, so the
 * reply itself is enough to name what is running.
 */
function adoptModel(
  model: HarnessState["model"],
  catalog: ModelInfo[],
): ModelInfo | null {
  if (!model?.id || !model.provider) return null;
  const known = catalog.find((m) => m.provider === model.provider && m.id === model.id);
  if (known) return known;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    api: model.api ?? "",
    baseUrl: model.baseUrl ?? null,
    reasoning: model.reasoning ?? false,
    input: model.input ?? [],
    contextWindow: model.contextWindow ?? 0,
    maxTokens: model.maxTokens ?? 0,
    thinkingLevels: model.thinking?.efforts ?? [],
    selector: null,
  };
}

export type Patch = Partial<Workspace> | ((w: Workspace) => Partial<Workspace>);

/** Applies a change to one workspace and re-projects if it is the visible one. */
export function patchWorkspace(
  set: (p: Partial<AppStore>) => void,
  get: () => AppStore,
  id: string,
  patch: Patch,
): void {
  const current = get().workspaces[id];
  if (!current) return;
  const next: Workspace = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
  const workspaces = { ...get().workspaces, [id]: next };
  set(id === get().activeWorkspaceId ? { workspaces, ...project(next) } : { workspaces });
}

export const createRuntimeSlice = (
  onEvent: (workspaceId: string, ev: BridgeEvent) => void,
): SliceOf<RuntimeSlice> => (set, get) => {
  const patch = (id: string, p: Patch) => patchWorkspace(set, get, id, p);
  const activeId = () => get().activeWorkspaceId;

  /** Called wherever the *set* of workspaces changes, never on transcript
   *  traffic — only identity is remembered, and identity does not move. */
  const remember = () => saveWorkspaces(get());

  /** Every start path funnels here, so resume, continue, and reconnect cannot
   *  drift apart. */
  const spawn = async (id: string, overrides: { sessionPath?: string | null; continueLast?: boolean }) => {
    const w = get().workspaces[id];
    if (!w || !w.cwd || w.connecting) return;
    if (w.runtime && !w.runtime.exited) await bridge.kill(w.runtime.id);
    cancelBridgeCalls("the previous session ended");
    patch(id, {
      connecting: true,
      connectionError: null,
      agent: initialState,
      verdict: null,
      tree: null,
      leafId: null,
      bridgeReady: false,
      harnessCommands: [],
      stats: null,
      speed: null,
      speedHistory: [],
      speedTracker: emptyTracker,
      selectedSessionPath: overrides.sessionPath ?? null,
    });
    try {
      const info = await bridge.startRuntime({
        harness: w.harness,
        cwd: w.cwd,
        host: w.target,
        sessionPath: overrides.sessionPath ?? null,
        continueLast: overrides.continueLast ?? false,
        model: w.selectedModel ? `${w.selectedModel.provider}/${w.selectedModel.id}` : null,
        thinking: w.thinking,
        approvalMode: null,
        noSession: false,
        onEvent: (ev) => onEvent(id, ev),
      });
      patch(id, { runtime: info, connecting: false, verdict: "live" });
      // The catalog is fetched by spawning a *second* harness process, so it is
      // loaded once per agent rather than on every session start — it competes
      // for the machine with the agent that is booting.
      if (!get().models.length) void get().loadModels();
      void get().loadCommands();
      void get().refreshContext();
      // Adopts the harness's own model and thinking level, so a new session
      // opens on whatever the agent is actually configured to use.
      void get().captureSessionFile();
      await get().replayHistory();
      void get().refreshTree();
    } catch (e) {
      patch(id, { connecting: false, connectionError: describeRuntimeError(e, w.harness, w.target) });
    }
  };

  /**
   * Starts a workspace that is not running, which is what opening one means.
   *
   * Clicking a project is a request to work in it, so the agent comes up on
   * its own rather than behind a button. Three cases are left alone: a
   * terminal, which opens its own pty when it mounts; an exited runtime, which
   * has the reconnect banner because reconnecting to a remote is a decision
   * and not a retry; and a workspace whose last start failed, which must not
   * respawn on every click.
   */
  const ensureRunning = (id: string) => {
    const w = get().workspaces[id];
    if (!w || w.kind !== "chat" || !w.cwd) return;
    if (w.runtime || w.connecting || w.connectionError) return;
    void spawn(id, { sessionPath: w.selectedSessionPath });
  };

  /** Most commands only make sense against the visible workspace. */
  const request = async (command: Record<string, unknown>): Promise<unknown> => {
    const id = activeId();
    const w = id ? get().workspaces[id] : null;
    if (!id || !w?.runtime || w.runtime.exited) return undefined;
    try {
      return await bridge.request(w.runtime.id, command);
    } catch (e) {
      patch(id, { connectionError: String(e) });
      return undefined;
    }
  };

  // Last session's workspaces, restored idle. `project` needs whichever was in
  // front, so the flat fields describe it from the first paint.
  const restored = loadWorkspaces();
  const first = restored?.activeWorkspaceId ? restored.workspaces[restored.activeWorkspaceId] : null;

  return {
    projects: restored?.projects ?? {},
    workspaces: restored?.workspaces ?? {},
    workspaceOrder: restored?.workspaceOrder ?? [],
    activeWorkspaceId: restored?.activeWorkspaceId ?? null,
    ...project(first ?? BLANK),

    openWorkspace(init) {
      const s = get();
      // One workspace per folder+machine+agent; asking again just goes there.
      // Resuming a session, or explicitly asking for a fresh one, opts out —
      // those are the two ways a folder legitimately holds several at once.
      const existing = s.workspaceOrder
        .map((id) => s.workspaces[id])
        .find(
          (w) =>
            w.cwd === init.cwd &&
            w.target === (init.target ?? null) &&
            w.harness === (init.harness ?? s.harness) &&
            w.kind === (init.kind ?? "chat") &&
            !init.sessionPath &&
            !init.fresh,
        );
      if (existing) {
        const savedProject = s.projects[init.cwd];
        if (!savedProject || savedProject.archived) {
          set({
            projects: {
              ...s.projects,
              [init.cwd]: { cwd: init.cwd, archived: false },
            },
          });
          remember();
        }
        get().activateWorkspace(existing.id);
        return existing.id;
      }
      const w = createWorkspace({
        harness: init.harness ?? s.harness,
        cwd: init.cwd,
        target: init.target ?? null,
        sessionPath: init.sessionPath ?? null,
        thinking: s.settings ? s.thinking : "medium",
        model: s.selectedModel,
        kind: init.kind,
        program: init.program,
      });
      set({
        projects: {
          ...s.projects,
          [init.cwd]: { cwd: init.cwd, archived: false },
        },
        workspaces: { ...s.workspaces, [w.id]: w },
        workspaceOrder: [w.id, ...s.workspaceOrder],
        activeWorkspaceId: w.id,
        ...project(w),
      });
      remember();
      void get().refreshSessions();
      ensureRunning(w.id);
      return w.id;
    },

    openTerminal(init) {
      return get().openWorkspace({
        cwd: init.cwd,
        target: init.target ?? null,
        kind: "terminal",
        program: init.program,
        // Terminals never dedupe: two shells in one folder is the normal case,
        // not an accident to be collapsed.
        fresh: true,
      });
    },

    activateWorkspace(id) {
      const w = get().workspaces[id];
      if (!w) return;
      // Arriving clears the "finished while you were away" mark.
      const cleared = { ...w, unread: false };
      set({
        workspaces: { ...get().workspaces, [id]: cleared },
        activeWorkspaceId: id,
        workspaceOrder: [id, ...get().workspaceOrder.filter((x) => x !== id)],
        ...project(cleared),
      });
      remember();
      ensureRunning(id);
      if (!cleared.tree) void get().refreshTree();
    },

    async closeWorkspace(id) {
      const w = get().workspaces[id];
      if (!w) return;
      closeTerminal(id);
      if (w.runtime && !w.runtime.exited) await bridge.kill(w.runtime.id);
      const workspaces = { ...get().workspaces };
      delete workspaces[id];
      const order = get().workspaceOrder.filter((x) => x !== id);
      const nextActive = get().activeWorkspaceId === id ? (order[0] ?? null) : get().activeWorkspaceId;
      set({
        workspaces,
        workspaceOrder: order,
        activeWorkspaceId: nextActive,
        ...project(nextActive ? workspaces[nextActive] : BLANK),
      });
      remember();
    },

    async archiveProject(cwd) {
      if (!cwd) return;
      const ids = get().workspaceOrder.filter((id) => get().workspaces[id]?.cwd === cwd);
      for (const id of ids) await get().closeWorkspace(id);

      set({
        projects: {
          ...get().projects,
          [cwd]: { cwd, archived: true },
        },
      });
      remember();
    },

    async deleteProject(cwd) {
      if (!cwd) return;
      const ids = get().workspaceOrder.filter((id) => get().workspaces[id]?.cwd === cwd);
      for (const id of ids) await get().closeWorkspace(id);

      const projects = { ...get().projects };
      delete projects[cwd];
      set({ projects });
      remember();
    },

    restoreProject(cwd) {
      const saved = get().projects[cwd];
      if (!saved?.archived) return;
      set({
        projects: {
          ...get().projects,
          [cwd]: { ...saved, archived: false },
        },
      });
      remember();
    },

    setHarness(harness) {
      const id = activeId();
      if (!id) {
        // No workspace yet: remember the choice for the first one opened.
        set({ ...project({ ...BLANK, harness }), harness });
        return;
      }
      if (get().workspaces[id].harness === harness) return;
      patch(id, { harness, selectedModel: null, tree: null, leafId: null });
      void get().stopRuntime();
      set({ models: [] });
      void get().loadModels();
      void get().refreshSessions();
    },

    setCwd(cwd) {
      get().openWorkspace({ cwd });
    },

    setTarget(alias) {
      const id = activeId();
      if (!id) {
        set({ ...project({ ...BLANK, target: alias }), target: alias });
        return;
      }
      patch(id, { target: alias, verdict: null, sessionFile: null, selectedSessionPath: null });
      void get().stopRuntime();
    },

    async startRuntime() {
      const id = activeId();
      if (id) await spawn(id, { sessionPath: get().workspaces[id].selectedSessionPath });
    },

    async stopRuntime() {
      const id = activeId();
      const w = id ? get().workspaces[id] : null;
      if (!id || !w?.runtime) return;
      cancelBridgeCalls("the session was stopped");
      await bridge.kill(w.runtime.id);
      patch(id, { runtime: { ...w.runtime, exited: true } });
    },

    async reconnect() {
      const id = activeId();
      const w = id ? get().workspaces[id] : null;
      if (id && w) await spawn(id, { sessionPath: w.sessionFile });
    },

    async resumeSession(session) {
      // A session belongs to its own folder, which may not be this workspace's.
      // Opening the workspace starts it, on the session it was opened for.
      get().openWorkspace({ cwd: session.cwd, sessionPath: session.path });
    },

    async continueLastSession() {
      const id = activeId();
      if (id) await spawn(id, { continueLast: true });
    },

    async replayHistory() {
      const id = activeId();
      const w = id ? get().workspaces[id] : null;
      if (!id || !w?.runtime || w.runtime.exited) return;
      try {
        const messages =
          data<{ messages?: Array<Record<string, unknown>> }>(
            await bridge.request(w.runtime.id, rpc.getMessages()),
          )?.messages ?? [];
        let agent = initialState;
        for (const m of messages) {
          agent = applyEvent(agent, { type: "message_start", message: m } as HarnessEvent);
          agent = applyEvent(agent, { type: "message_end", message: m } as HarnessEvent);
        }
        patch(id, { agent });
        await get().captureSessionFile();
      } catch {
        /* replay is best-effort; live turns still work without it */
      }
    },

    async sendPrompt(text, images = []) {
      const id = activeId();
      const w = id ? get().workspaces[id] : null;
      if (!id || !w?.runtime || w.runtime.exited) return;
      // The clock starts here, not at agent_start: the wait before the first
      // token is prompt processing, and that is what we are measuring.
      patch(id, { speedTracker: { ...emptyTracker, startedAt: performance.now() }, speed: null });
      try {
        await bridge.request(w.runtime.id, rpc.promptWith(text, images));
        void get().refreshContext();
      } catch (e) {
        patch(id, { connectionError: String(e) });
      }
    },

    async steer(text) {
      await request(rpc.steer(text));
    },

    async followUp(text) {
      await request(rpc.followUp(text));
    },

    async abort() {
      await request(rpc.abort());
    },

    rawCommand: request,

    async respondApproval(payload) {
      const id = activeId();
      const w = id ? get().workspaces[id] : null;
      const approval = w?.agent.pendingApproval;
      if (!id || !w?.runtime || !approval) return;
      try {
        // The envelope is flat — `{type, id, value}` / `{…, confirmed}` /
        // `{…, cancelled}`. Nesting the answer under `payload` reads to the
        // harness as neither a value nor a confirmation, which silently
        // resolves the dialog as cancelled and denies whatever it was asking.
        await bridge.send(w.runtime.id, {
          type: "extension_ui_response",
          id: approval.requestId,
          ...payload,
        });
        patch(id, { agent: { ...w.agent, pendingApproval: null } });
      } catch (e) {
        patch(id, { connectionError: String(e) });
      }
    },

    // `get_session_stats` answers both of these, and it was already being
    // called for the context readout while everything else in the reply — cost,
    // token counts, message counts — was thrown away. Keeping it means the
    // strip under the composer can show the running cost without a second call.
    async refreshContext() {
      await get().refreshStats();
    },

    async refreshStats() {
      const id = activeId();
      const stats = data<SessionStats>(await request(rpc.getSessionStats()));
      if (id && stats) patch(id, { stats, context: stats.contextUsage ?? get().context });
    },

    async captureSessionFile() {
      const id = activeId();
      const state = data<HarnessState>(await request(rpc.getState()));
      if (!id || !state) return;
      // The harness already has a model and a thinking level chosen — its own
      // config default, or whatever `/model` last set. Adopting them is what
      // stops the app asking for a choice that was already made; because every
      // change we make goes out as `set_model` first, what comes back is
      // always the answer to our own last word.
      const adopted = adoptModel(state.model, get().models);
      patch(id, (w) => ({
        sessionFile: state.sessionFile ?? w.sessionFile,
        // The session's measured turns, which are ours rather than the
        // harness's. Loaded once, when the file this run belongs to becomes
        // known; a history already in hand is the newer one.
        speedHistory: w.speedHistory.length
          ? w.speedHistory
          : loadSpeedHistory(state.sessionFile ?? w.sessionFile),
        sessionName: state.sessionName ?? w.sessionName,
        selectedModel: adopted ?? w.selectedModel,
        thinking: state.thinkingLevel ?? w.thinking,
      }));
      // The session file and its name only become known here, and they are what
      // a restored workspace reopens.
      remember();
    },

    async compact(instructions) {
      await request(rpc.compact(instructions));
      void get().refreshContext();
    },

    async newSession() {
      const id = activeId();
      await request(rpc.newSession());
      if (id) {
        patch(id, {
          agent: initialState,
          tree: null,
          leafId: null,
          stats: null,
          speed: null,
          speedHistory: [],
        });
      }
      void get().captureSessionFile();
      void get().refreshSessions();
    },

    async renameSession(name) {
      const id = activeId();
      await request(rpc.setSessionName(name));
      if (id) patch(id, { sessionName: name });
      void get().refreshSessions();
    },

    async exportSession() {
      return data<{ path?: string }>(await request(rpc.exportHtml()))?.path ?? null;
    },

    async runBash(command) {
      return data<BashResult>(await request(rpc.bash(command))) ?? null;
    },

    async abortBash() {
      await request(rpc.abortBash());
    },
  };
};

/** Loss of contact is not evidence of death: an ssh channel can drop while the
 *  agent keeps running server-side, so a remote exit is only "unverifiable"
 *  until a reconnect proves otherwise. */
export function exitVerdict(host: string | null | undefined, code: number | null) {
  if (host === null || host === undefined) return "exited" as const;
  return code === 0 ? ("exited" as const) : ("unverifiable" as const);
}

export type { ImageAttachment };
