/**
 * The app store: slices composed into one zustand store.
 *
 * This file owns what the slices cannot — the bridge event handler. It routes
 * every frame to the workspace that produced it (so a background session keeps
 * building its transcript while you look at another), batches harness events
 * into one state flush per frame rather than one per delta, measures
 * throughput, and hands bridge-extension replies to whoever is awaiting them.
 */

import { create } from "zustand";
import { applyEvent } from "./agent-reducer";
import type { HarnessEvent } from "./agent-state";
import { parseBridgeReply, type BridgeEvent } from "./bridge";
import { beginTurn, endMessage, observeDelta, settleTurn } from "./speed";
import { saveSpeedHistory } from "./store/speed-history";
import { deliverBridgeReply } from "./store/bridge-rpc";
import { createCatalogSlice } from "./store/catalog-slice";
import { createCommandsSlice, normalizeCommands } from "./store/commands-slice";
import { createRuntimeSlice, exitVerdict, patchWorkspace } from "./store/runtime-slice";
import { createSettingsSlice } from "./store/settings-slice";
import { createTreeSlice } from "./store/tree-slice";
import { createUiSlice } from "./store/ui-slice";
import { createUsageSlice } from "./store/usage-slice";
import type { AppStore } from "./store/types";
import { project, type Workspace } from "./store/workspace";

export type { AppStore };
export type { PanelId, Route, SessionStats, Settings, ThinkingPace, UsageReport, Verdict } from "./store/types";
export type { Workspace } from "./store/workspace";

/** Events buffered per workspace, flushed together on the next frame. */
const buffers = new Map<string, HarnessEvent[]>();
let flushScheduled = false;

/** Characters of streamed output in the pending batch, per workspace — the
 *  live throughput estimate, since token counts only arrive at message_end. */
const pendingChars = new Map<string, number>();

function textDeltaChars(ev: HarnessEvent): number {
  if (ev.type !== "message_update") return 0;
  const delta = ev.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
  if (delta?.type !== "text_delta" && delta?.type !== "thinking_delta") return 0;
  return typeof delta.delta === "string" ? delta.delta.length : 0;
}

function scheduleFlush(set: (p: Partial<AppStore>) => void, get: () => AppStore) {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const now = performance.now();
    for (const [workspaceId, batch] of buffers) {
      if (!batch.length) continue;
      const chars = pendingChars.get(workspaceId) ?? 0;
      pendingChars.set(workspaceId, 0);
      patchWorkspace(set, get, workspaceId, (w: Workspace) => {
        const tracker = chars > 0 ? observeDelta(w.speedTracker, chars, now) : w.speedTracker;
        return {
          agent: batch.reduce(applyEvent, w.agent),
          speedTracker: tracker,
          speed: tracker.sample ?? w.speed,
        };
      });
    }
    buffers.clear();
  });
}

async function notifyTurnFinished(title: string) {
  const { sendNotification, isPermissionGranted, requestPermission } = await import(
    "@tauri-apps/plugin-notification"
  );
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (granted) sendNotification({ title: "The agent finished", body: `${title} — its turn settled.` });
}

/** Output tokens the harness reported for a finished assistant message. */
function outputTokensOf(ev: HarnessEvent): number | null {
  const usage = (ev.message as { usage?: { output?: number } } | undefined)?.usage;
  return typeof usage?.output === "number" ? usage.output : null;
}

export const useAppStore = create<AppStore>((set, get) => {
  const handleBridgeEvent = (workspaceId: string, ev: BridgeEvent) => {
    const patch = (p: Parameters<typeof patchWorkspace>[3]) =>
      patchWorkspace(set, get, workspaceId, p);

    if (ev.kind === "exited") {
      const w = get().workspaces[workspaceId];
      if (!w) return;
      patch({
        runtime: w.runtime ? { ...w.runtime, exited: true } : null,
        connectionError: ev.error ? `The agent exited: ${ev.error}` : null,
        verdict: w.runtime ? exitVerdict(w.runtime.host, ev.code) : null,
      });
      return;
    }

    const event = ev.data;

    // Bridge replies are control plane, not conversation: hand them to the
    // caller that is waiting and keep them out of the transcript entirely.
    if (event.type === "extension_ui_request" && event.method === "notify") {
      const reply = parseBridgeReply(event.message);
      if (reply) {
        if (reply.command === "pd-state" && reply.ok) {
          patch({ leafId: (reply.data?.leafId as string | null) ?? null, bridgeReady: true });
        }
        deliverBridgeReply(reply);
        return;
      }
    }

    const batch = buffers.get(workspaceId);
    if (batch) batch.push(event);
    else buffers.set(workspaceId, [event]);
    pendingChars.set(workspaceId, (pendingChars.get(workspaceId) ?? 0) + textDeltaChars(event));
    scheduleFlush(set, get);

    switch (event.type) {
      case "agent_start":
        // A turn the user did not start here — a queued follow-up, or a resumed
        // run — still needs a clock, but never overwrites one already running.
        patch((w) => (w.speedTracker.startedAt === null ? { speedTracker: beginTurn(performance.now()) } : {}));
        break;

      case "message_end":
        // Folds this message into the turn. Not the end of the turn: a tool
        // call means more messages follow, and counting each one as a turn is
        // what made a single prompt report as two.
        patch((w) => {
          const tracker = endMessage(w.speedTracker, outputTokensOf(event), performance.now());
          return { speedTracker: tracker, speed: tracker.sample ?? w.speed };
        });
        break;

      case "agent_settled":
      case "agent_end": {
        // The turn is over, so it becomes one entry in the session's history.
        patch((w) => {
          const tracker = settleTurn(w.speedTracker, performance.now());
          const settled = tracker.sample;
          // Only a measurable turn joins the history — an unmeasured one would
          // pull the session averages toward nothing.
          if (settled?.tokensPerSecond == null) return { speedTracker: tracker };
          const speedHistory = [...w.speedHistory, settled];
          saveSpeedHistory(w.sessionFile, speedHistory);
          return { speedTracker: tracker, speed: settled, speedHistory };
        });
        void get().captureSessionFile();
        if (workspaceId === get().activeWorkspaceId) {
          // The turn appended entries, so the leaf moved and the tree is stale.
          void get().refreshTree();
          // Cost and context were only refreshed when a prompt was *sent*,
          // which meant both readouts described the session as it was before
          // the turn that just finished — always one turn behind.
          void get().refreshContext();
        }
        if (event.type === "agent_settled") {
          const w = get().workspaces[workspaceId];
          const elsewhere = document.hidden || workspaceId !== get().activeWorkspaceId;
          if (elsewhere) {
            patch({ unread: true });
            if (get().settings.notifyOnSettle && w) {
              void notifyTurnFinished(w.sessionName ?? w.cwd.split("/").pop() ?? "Session");
            }
          }
        }
        break;
      }

      case "available_commands_update":
        // omp's push. pi never sends this, which is why the store also polls.
        patch({ harnessCommands: normalizeCommands(event.commands) });
        break;

      case "model_changed": {
        const model = event.model as { provider?: string; id?: string } | undefined;
        const w = get().workspaces[workspaceId];
        if (model?.id && w && !w.selectedModel) {
          patch({
            selectedModel:
              get().models.find((m) => m.id === model.id && m.provider === model.provider) ?? null,
          });
        }
        break;
      }
    }
  };

  return {
    ...createRuntimeSlice(handleBridgeEvent)(set, get),
    ...createCatalogSlice(set, get),
    ...createTreeSlice(set, get),
    ...createCommandsSlice(set, get),
    ...createUiSlice(set, get),
    ...createSettingsSlice(set, get),
    ...createUsageSlice(set, get),
  };
});

export { project };
