/**
 * Workspace lifecycle and everything that talks to a live agent.
 *
 * Several workspaces run at once. Each owns its runtime, transcript, tree, and
 * speed figures; the store's flat fields are a projection of whichever one is
 * active, so switching is a re-point rather than a reload and a turn left
 * generating keeps generating.
 */

import { applyEvent } from "../agent-reducer";
import { initialState, type HarnessEvent } from "../agent-state";
import { bridge, rpc, type BridgeEvent, type ImageAttachment } from "../bridge";
import { describeRuntimeError } from "../errors";
import { emptyTracker } from "../speed";
import { cancelBridgeCalls } from "./bridge-rpc";
import type { AppStore, BashResult, RuntimeSlice, SessionStats, SliceOf } from "./types";
import { BLANK, createWorkspace, project, type Workspace } from "./workspace";

/** Unwraps `{ data }` from a correlated RPC response. */
function data<T>(response: unknown): T | undefined {
  return (response as { data?: T } | undefined)?.data;
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
      void get().loadModels();
      void get().loadCommands();
      void get().refreshContext();
      await get().replayHistory();
      void get().refreshTree();
    } catch (e) {
      patch(id, { connecting: false, connectionError: describeRuntimeError(e, w.harness, w.target) });
    }
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

  return {
    workspaces: {},
    workspaceOrder: [],
    activeWorkspaceId: null,
    ...project(BLANK),

    openWorkspace(init) {
      const s = get();
      // One workspace per folder+machine+agent; asking again just goes there.
      const existing = s.workspaceOrder
        .map((id) => s.workspaces[id])
        .find(
          (w) =>
            w.cwd === init.cwd &&
            w.target === (init.target ?? null) &&
            w.harness === (init.harness ?? s.harness) &&
            !init.sessionPath,
        );
      if (existing) {
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
      });
      set({
        workspaces: { ...s.workspaces, [w.id]: w },
        workspaceOrder: [w.id, ...s.workspaceOrder],
        activeWorkspaceId: w.id,
        ...project(w),
      });
      void get().refreshSessions();
      return w.id;
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
      if (!cleared.tree) void get().refreshTree();
    },

    async closeWorkspace(id) {
      const w = get().workspaces[id];
      if (!w) return;
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
      const id = get().openWorkspace({ cwd: session.cwd, sessionPath: session.path });
      patch(id, { selectedSessionPath: session.path });
      await spawn(id, { sessionPath: session.path });
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

    async refreshContext() {
      const id = activeId();
      const usage = data<{ contextUsage?: SessionStats["contextUsage"] }>(
        await request(rpc.getSessionStats()),
      )?.contextUsage;
      if (id && usage) patch(id, { context: usage });
    },

    async refreshStats() {
      const id = activeId();
      const stats = data<SessionStats>(await request(rpc.getSessionStats()));
      if (id && stats) patch(id, { stats, context: stats.contextUsage ?? get().context });
    },

    async captureSessionFile() {
      const id = activeId();
      const state = data<{ sessionFile?: string; sessionName?: string }>(await request(rpc.getState()));
      if (!id || !state) return;
      patch(id, (w) => ({
        sessionFile: state.sessionFile ?? w.sessionFile,
        sessionName: state.sessionName ?? w.sessionName,
      }));
    },

    async compact(instructions) {
      await request(rpc.compact(instructions));
      void get().refreshContext();
    },

    async newSession() {
      const id = activeId();
      await request(rpc.newSession());
      if (id) {
        patch(id, { agent: initialState, tree: null, leafId: null, stats: null, speed: null });
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
