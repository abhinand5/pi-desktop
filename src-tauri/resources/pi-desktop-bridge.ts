/**
 * pi-desktop bridge — exposes session-tree navigation to the desktop client.
 *
 * Neither pi nor omp exposes leaf movement (the `/tree` verb) over RPC: the
 * only caller of `SessionManager.branch()` is `AgentSession.navigateTree()`,
 * which reaches extensions as `ctx.navigateTree()` and nothing else. This
 * extension bridges that gap — the desktop invokes `/pd-*` over the ordinary
 * `prompt` command and reads replies off the `notify` channel.
 *
 * Loaded per-run via `-e <path>`; nothing is installed into ~/.pi or ~/.omp.
 *
 * Deliberately importless and duck-typed: pi and omp expose the same extension
 * API under different package names, so one file serves both.
 */

const PREFIX = "pi-desktop:";
const PREVIEW_CHARS = 140;
/** Guards against a pathological session flooding a single JSONL frame. */
const MAX_NODES = 4000;

type AnyRecord = Record<string, any>;

/** Replies travel back over `notify`, the one fire-and-forget channel RPC mode
 *  keeps functional (ctx.hasUI stays true there). The desktop matches on the
 *  prefix and swallows the frame; a human running this in the TUI sees one
 *  compact line rather than a JSON dump. */
function reply(ctx: AnyRecord, command: string, ok: boolean, data: unknown): void {
  const body = JSON.stringify({ v: 1, command, ok, data });
  try {
    ctx?.ui?.notify?.(PREFIX + body, ok ? "info" : "error");
  } catch {
    /* A desktop that has gone away must not take the agent down with it. */
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: AnyRecord) => block?.type === "text")
    .map((block: AnyRecord) => String(block.text ?? ""))
    .join("");
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

/** Projects a session entry to the same shape the Rust-side JSONL reader
 *  produces, so the desktop renders one node type regardless of source. */
function project(entry: AnyRecord): AnyRecord {
  const node: AnyRecord = {
    id: entry.id,
    parentId: entry.parentId ?? null,
    type: entry.type,
    timestamp: entry.timestamp,
  };
  switch (entry.type) {
    case "message": {
      const message = entry.message ?? {};
      node.role = message.role;
      if (message.role === "toolResult") {
        node.toolName = message.toolName;
        node.isError = message.isError === true;
        node.preview = clip(textOf(message.content));
      } else if (message.role === "assistant") {
        const blocks: AnyRecord[] = Array.isArray(message.content) ? message.content : [];
        node.preview = clip(blocks.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join(""));
        node.toolCalls = blocks.filter((b) => b?.type === "toolCall").map((b) => String(b.name ?? ""));
        node.model = message.model;
        node.provider = message.provider;
        node.stopReason = message.stopReason;
      } else {
        node.preview = clip(textOf(message.content));
      }
      break;
    }
    case "compaction":
      node.preview = clip(String(entry.summary ?? ""));
      node.tokensBefore = entry.tokensBefore;
      break;
    case "branch_summary":
      node.preview = clip(String(entry.summary ?? ""));
      node.fromId = entry.fromId;
      break;
    case "model_change":
      // pi splits provider/modelId; omp stores one "provider/id" string.
      node.preview =
        entry.provider && entry.modelId
          ? `${entry.provider}/${entry.modelId}`
          : String(entry.model ?? "");
      break;
    case "thinking_level_change":
      node.preview = String(entry.thinkingLevel ?? "");
      break;
    case "custom_message":
      node.preview = clip(textOf(entry.content));
      node.customType = entry.customType;
      break;
    case "custom":
      node.customType = entry.customType;
      node.preview = "";
      break;
    case "session_info":
      node.preview = clip(String(entry.name ?? ""));
      break;
    case "label":
      node.targetId = entry.targetId;
      node.preview = clip(String(entry.label ?? ""));
      break;
    default:
      node.preview = "";
  }
  return node;
}

/** Flat node list plus leafId. Flat rather than nested: parentId is already on
 *  every node, the desktop builds the same tree from disk-read sessions, and a
 *  flat array keeps the reply frame small. */
function snapshot(ctx: AnyRecord): AnyRecord {
  const manager = ctx?.sessionManager;
  const entries: AnyRecord[] = manager?.getEntries?.() ?? [];
  const truncated = entries.length > MAX_NODES;
  const kept = truncated ? entries.slice(entries.length - MAX_NODES) : entries;
  const nodes = kept.map(project);
  for (const node of nodes) {
    const label = manager?.getLabel?.(node.id);
    if (typeof label === "string" && label) node.label = label;
  }
  return {
    nodes,
    truncated,
    leafId: manager?.getLeafId?.() ?? null,
    sessionFile: manager?.getSessionFile?.() ?? null,
    sessionId: manager?.getSessionId?.() ?? null,
    sessionName: manager?.getSessionName?.() ?? null,
  };
}

/** `--summarize` / `--summarize=<focus>` before the positional entry id. */
function parseGotoArgs(raw: string): { entryId: string; summarize: boolean; customInstructions?: string } {
  let summarize = false;
  let customInstructions: string | undefined;
  const positional: string[] = [];
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    if (token === "--summarize") summarize = true;
    else if (token.startsWith("--summarize=")) {
      summarize = true;
      customInstructions = token.slice("--summarize=".length);
    } else positional.push(token);
  }
  return { entryId: positional[0] ?? "", summarize, customInstructions };
}

export default function (pi: AnyRecord) {
  pi.registerCommand("pd-state", {
    description: "pi-desktop: report the current leaf and session file",
    handler: async (_args: string, ctx: AnyRecord) => {
      reply(ctx, "pd-state", true, {
        leafId: ctx?.sessionManager?.getLeafId?.() ?? null,
        sessionFile: ctx?.sessionManager?.getSessionFile?.() ?? null,
        sessionId: ctx?.sessionManager?.getSessionId?.() ?? null,
        sessionName: ctx?.sessionManager?.getSessionName?.() ?? null,
      });
    },
  });

  pi.registerCommand("pd-tree", {
    description: "pi-desktop: dump the session tree",
    handler: async (_args: string, ctx: AnyRecord) => {
      try {
        reply(ctx, "pd-tree", true, snapshot(ctx));
      } catch (error: any) {
        reply(ctx, "pd-tree", false, { error: String(error?.message ?? error) });
      }
    },
  });

  pi.registerCommand("pd-goto", {
    description: "pi-desktop: move the session leaf to an entry",
    handler: async (args: string, ctx: AnyRecord) => {
      const { entryId, summarize, customInstructions } = parseGotoArgs(args);
      if (!entryId) {
        reply(ctx, "pd-goto", false, { error: "usage: /pd-goto <entryId> [--summarize[=focus]]" });
        return;
      }
      if (typeof ctx?.navigateTree !== "function") {
        reply(ctx, "pd-goto", false, { error: "navigateTree unavailable in this harness build" });
        return;
      }
      const manager = ctx?.sessionManager;
      const target = manager?.getEntry?.(entryId);
      if (!target) {
        reply(ctx, "pd-goto", false, { error: `entry ${entryId} not found` });
        return;
      }
      // ctx.navigateTree returns only { cancelled } — it strips the editorText
      // the TUI uses — so read the restorable prompt off the entry instead.
      const editorText =
        target.type === "message" && target.message?.role === "user"
          ? textOf(target.message.content)
          : target.type === "custom_message"
            ? textOf(target.content)
            : null;
      const previousLeafId = manager?.getLeafId?.() ?? null;
      try {
        const result = await ctx.navigateTree(entryId, {
          summarize,
          ...(customInstructions ? { customInstructions } : {}),
        });
        reply(ctx, "pd-goto", true, {
          cancelled: result?.cancelled === true,
          previousLeafId,
          // A user entry moves the leaf to its parent and hands the prompt
          // back for editing; anything else moves the leaf to itself.
          editorText,
          leafId: manager?.getLeafId?.() ?? null,
        });
      } catch (error: any) {
        reply(ctx, "pd-goto", false, { error: String(error?.message ?? error), previousLeafId });
      }
    },
  });

  pi.registerCommand("pd-label", {
    description: "pi-desktop: set or clear a label on an entry",
    handler: async (args: string, ctx: AnyRecord) => {
      const trimmed = args.trim();
      const split = trimmed.indexOf(" ");
      const entryId = split === -1 ? trimmed : trimmed.slice(0, split);
      const label = split === -1 ? "" : trimmed.slice(split + 1).trim();
      if (!entryId) {
        reply(ctx, "pd-label", false, { error: "usage: /pd-label <entryId> [label]" });
        return;
      }
      try {
        // An empty label clears, per pi.setLabel's undefined contract.
        pi.setLabel(entryId, label || undefined);
        reply(ctx, "pd-label", true, { entryId, label: label || null });
      } catch (error: any) {
        reply(ctx, "pd-label", false, { error: String(error?.message ?? error) });
      }
    },
  });
}
