/**
 * The session tree: reading it, and moving through it.
 *
 * Reads come from whichever source is available — pi answers `get_tree` over
 * RPC, omp answers nothing at all, and the session file on disk answers for
 * both even with no runtime attached. Writes (leaf movement, labels) always go
 * through the bundled bridge extension, because no RPC command reaches
 * `navigateTree`.
 */

import { bridge, bridgeCmd, rpc, type SessionTree, type TreeNode } from "../bridge";
import { nearestUserEntry } from "../tree";
import { BridgeUnavailableError, callBridge } from "./bridge-rpc";
import { patchWorkspace } from "./runtime-slice";
import type { SliceOf, TreeSlice } from "./types";

/** pi's `get_tree` returns `{entry, children}` nodes; flatten to our shape. */
export function flattenPiTree(raw: unknown): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const row = node as { entry?: Record<string, unknown>; children?: unknown[]; label?: unknown };
    const entry = row.entry;
    if (entry && typeof entry.id === "string") {
      out.push(projectEntry(entry, typeof row.label === "string" ? row.label : undefined));
    }
    for (const child of row.children ?? []) visit(child);
  };
  for (const root of Array.isArray(raw) ? raw : []) visit(root);
  return out;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text?: string } => !!b && (b as { type?: string }).type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

/** Same projection the Rust reader and the bridge extension apply, so all
 *  three sources produce one node shape. */
function projectEntry(entry: Record<string, unknown>, label?: string): TreeNode {
  const type = String(entry.type ?? "");
  const node: TreeNode = {
    id: String(entry.id),
    parentId: (entry.parentId as string | null) ?? null,
    type,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
    preview: "",
    label,
  };
  if (type === "message") {
    const message = (entry.message ?? {}) as Record<string, unknown>;
    node.role = typeof message.role === "string" ? message.role : undefined;
    if (node.role === "assistant") {
      const blocks = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
      node.preview = clip(text(blocks));
      node.toolCalls = blocks.filter((b) => b.type === "toolCall").map((b) => String(b.name ?? ""));
      node.model = typeof message.model === "string" ? message.model : undefined;
      node.provider = typeof message.provider === "string" ? message.provider : undefined;
      node.stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    } else if (node.role === "toolResult") {
      node.toolName = typeof message.toolName === "string" ? message.toolName : undefined;
      node.isError = message.isError === true;
      node.preview = clip(text(message.content));
    } else {
      node.preview = clip(text(message.content));
    }
  } else if (type === "compaction" || type === "branch_summary") {
    node.preview = clip(String(entry.summary ?? ""));
    node.fromId = typeof entry.fromId === "string" ? entry.fromId : undefined;
  } else if (type === "model_change") {
    node.preview =
      entry.provider && entry.modelId
        ? `${entry.provider}/${entry.modelId}`
        : String(entry.model ?? "");
  } else if (type === "thinking_level_change") {
    node.preview = String(entry.thinkingLevel ?? "");
  } else if (type === "custom_message") {
    node.customType = typeof entry.customType === "string" ? entry.customType : undefined;
    node.preview = clip(text(entry.content));
  } else if (type === "label") {
    node.fromId = typeof entry.targetId === "string" ? entry.targetId : undefined;
    node.preview = clip(String(entry.label ?? ""));
  }
  return node;
}

export const createTreeSlice: SliceOf<TreeSlice> = (set, get) => {
  /** Tree state belongs to the workspace it describes, not to the store. */
  const patch = (p: Parameters<typeof patchWorkspace>[3]) => {
    const id = get().activeWorkspaceId;
    if (id) patchWorkspace(set, get, id, p);
  };

  /** Sends a bridge command as a prompt. Extension commands run even while the
   *  agent is streaming, so this never has to wait for a turn to settle. */
  const send = async (promptText: string) => {
    const { runtime } = get();
    if (!runtime || runtime.exited) throw new Error("no running session");
    return bridge.request(runtime.id, rpc.prompt(promptText));
  };

  const markBridgeMissing = () => {
    if (!get().bridgeReady) return;
    patch({ bridgeReady: false });
    get().setNotice(
      "In-place branching is off — the session bridge did not load. Branching will create separate sessions instead.",
    );
  };

  return {
    async refreshTree() {
      const { runtime, harness, sessionFile, target } = get();
      patch({ treeLoading: true, treeError: null });
      try {
        // 1. A live pi answers get_tree natively, leaf included.
        if (runtime && !runtime.exited && harness === "pi") {
          const response = (await get().rawCommand(rpc.getTree())) as
            | { data?: { tree?: unknown; leafId?: string | null } }
            | undefined;
          const nodes = flattenPiTree(response?.data?.tree);
          if (nodes.length) {
            patch({
              tree: { nodes, truncated: false },
              leafId: response?.data?.leafId ?? null,
              treeLoading: false,
              bridgeReady: get().bridgeReady,
            });
            return;
          }
        }

        // 2. Otherwise ask the bridge extension, which both harnesses support
        //    and which is the only source that knows the live leaf on omp.
        if (runtime && !runtime.exited) {
          try {
            const reply = await callBridge(send, "pd-tree", bridgeCmd.tree());
            patch({
              tree: { nodes: (reply.nodes as TreeNode[]) ?? [], truncated: reply.truncated === true },
              leafId: (reply.leafId as string | null) ?? null,
              treeLoading: false,
              bridgeReady: true,
            });
            return;
          } catch (e) {
            if (e instanceof BridgeUnavailableError) markBridgeMissing();
            else throw e;
          }
        }

        // 3. No runtime, or no bridge: read the file. Works for a session that
        //    has never been opened, which is what makes tree preview possible.
        if (sessionFile) {
          const tree: SessionTree = target
            ? await bridge.sessionTreeRemote(target, null, sessionFile)
            : await bridge.sessionTree(sessionFile);
          patch({
            tree,
            // Without the harness, the last appended entry is the best guess.
            leafId: get().leafId ?? tree.lastEntryId ?? null,
            treeLoading: false,
          });
          return;
        }
        patch({ tree: null, treeLoading: false });
      } catch (e) {
        patch({ treeLoading: false, treeError: String((e as Error)?.message ?? e) });
      }
    },

    async gotoEntry(entryId, options) {
      // Branching away from a turn that is still writing would race the leaf
      // move against the append; settle first.
      if (get().agent.streaming) await get().abort();
      try {
        const reply = await callBridge(
          send,
          "pd-goto",
          bridgeCmd.goto(
            entryId,
            options?.summarize ? { customInstructions: options.customInstructions } : undefined,
          ),
          // A branch summary calls the model, so it needs a longer leash.
          options?.summarize ? 120_000 : 8000,
        );
        if (reply.cancelled === true) return null;
        patch({ leafId: (reply.leafId as string | null) ?? null, bridgeReady: true });
        // The leaf moved, so the transcript no longer describes the session.
        await get().replayHistory();
        void get().refreshTree();
        void get().refreshContext();
        return (reply.editorText as string | null) ?? null;
      } catch (e) {
        if (e instanceof BridgeUnavailableError) markBridgeMissing();
        else patch({ treeError: String((e as Error)?.message ?? e) });
        return null;
      }
    },

    async labelEntry(entryId, label) {
      try {
        await callBridge(send, "pd-label", bridgeCmd.label(entryId, label));
        void get().refreshTree();
      } catch (e) {
        if (e instanceof BridgeUnavailableError) markBridgeMissing();
      }
    },

    async retryEntry(entryId, text) {
      // Navigating to a user entry parks the leaf on its parent and hands the
      // prompt back, so re-sending it grows a sibling branch and leaves the
      // original answer reachable.
      const restored = await get().gotoEntry(entryId);
      const prompt = text ?? restored;
      if (!prompt) return;
      await get().sendPrompt(prompt);
    },

    async forkFrom(entryId) {
      // A separate session file, unlike gotoEntry. Only user entries qualify —
      // the harness rejects anything else as an invalid fork target.
      await get().rawCommand(rpc.fork(entryId));
      await get().captureSessionFile();
      await get().replayHistory();
      void get().refreshTree();
      void get().refreshSessions();
    },

    async cloneSession() {
      await get().rawCommand(rpc.clone());
      await get().captureSessionFile();
      void get().refreshSessions();
    },
  };
};

/** Re-exported for the retry path in the UI. */
export { nearestUserEntry };
