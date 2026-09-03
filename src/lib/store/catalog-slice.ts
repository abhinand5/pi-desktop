/** Model, session, provider, and host catalogs — everything the app reads
 *  about the harness rather than from a running agent. */

import { bridge, rpc } from "../bridge";
import { patchWorkspace } from "./runtime-slice";
import { forgetSpeedHistory } from "./speed-history";
import type { CatalogSlice, SliceOf } from "./types";

export const createCatalogSlice: SliceOf<CatalogSlice> = (set, get) => ({
  models: [],
  modelsError: null,
  modelsFor: null,
  harnessDefault: null,
  sessions: [],
  providers: [],
  hosts: [],

  async loadModels() {
    // A catalog belongs to a machine and an agent: a remote box has its own
    // providers, its own keys, and its own configured models.
    const machine = get().activeMachine;
    const harness = get().harness;
    set({ modelsError: null, modelsFor: `${harness}@${machine ?? ""}` });
    try {
      const models = await bridge.models(harness, machine);
      // Another machine was selected while this was in flight; its answer wins.
      if (get().modelsFor !== `${harness}@${machine ?? ""}`) return;
      set({ models });
      // Re-point the selection at the freshly loaded catalog entry, so a
      // reloaded model list does not leave a stale object selected. A model the
      // catalog does not list is kept rather than cleared: the harness can be
      // running one that `get_available_models` never returns, and dropping it
      // would put the app back to "choose a model" for no reason.
      const id = get().activeWorkspaceId;
      const current = get().selectedModel;
      if (id && current) {
        patchWorkspace(set, get, id, {
          selectedModel:
            models.find((m) => m.provider === current.provider && m.id === current.id) ?? current,
        });
      }
    } catch (e) {
      set({ modelsError: String(e) });
    }
  },

  async selectModel(model) {
    const id = get().activeWorkspaceId;
    if (id) patchWorkspace(set, get, id, { selectedModel: model });
    if (get().runtime && !get().runtime?.exited) {
      await get().rawCommand(rpc.setModel(model.provider, model.id));
    }
  },

  async loadHarnessDefault() {
    try {
      set({ harnessDefault: await bridge.harnessDefaultModel(get().harness) });
    } catch {
      // No readable config means no configured default; the harness then
      // picks its own fallback, which the chip adopts once the session boots.
      set({ harnessDefault: null });
    }
  },

  async setDefaultModel(model) {
    await bridge.setHarnessDefaultModel(get().harness, model);
    // Re-read rather than trusting the write: the UI shows what stuck.
    await get().loadHarnessDefault();
  },

  async setThinking(level) {
    const id = get().activeWorkspaceId;
    if (id) patchWorkspace(set, get, id, { thinking: level });
    if (get().runtime && !get().runtime?.exited) {
      await get().rawCommand(rpc.setThinkingLevel(level));
    }
  },

  async refreshSessions() {
    const sessions = await bridge.sessions(get().harness).catch(() => []);
    set({ sessions });

    const titleByPath = new Map(sessions.map((session) => [session.path, session.name?.trim()]));
    for (const [id, workspace] of Object.entries(get().workspaces)) {
      const path = workspace.sessionFile ?? workspace.selectedSessionPath;
      const title = path ? titleByPath.get(path) : undefined;
      if (title && title !== workspace.sessionName) patchWorkspace(set, get, id, { sessionName: title });
    }
  },

  async deleteSession(path) {
    await bridge.deleteSession(path);
    forgetSpeedHistory(path);
    // A deleted session must not linger as a resume target.
    if (get().selectedSessionPath === path) set({ selectedSessionPath: null });
    await get().refreshSessions();
  },

  async loadHosts() {
    const hosts = await bridge.sshHosts().catch(() => []);
    set({ hosts });
  },

  async addHost(alias, destination, port) {
    await bridge.sshHostAdd(alias, destination, port);
    await get().loadHosts();
  },

  async removeHost(alias) {
    await bridge.sshHostRemove(alias);
    if (get().target === alias) set({ target: null });
    await get().loadHosts();
  },

  async loadProviders() {
    const providers = await bridge.providers(get().harness).catch(() => []);
    set({ providers });
  },

  async saveProvider(id, config) {
    await bridge.upsertProvider(get().harness, id, config);
    await get().loadProviders();
    await get().loadModels();
  },

  async deleteProvider(id) {
    await bridge.removeProvider(get().harness, id);
    await get().loadProviders();
    await get().loadModels();
  },

  async testProviderConnection(baseUrl, apiKey) {
    return bridge.testProvider(baseUrl, apiKey);
  },
});
