/**
 * Pure helpers over a session tree.
 *
 * A session is an append-only tree: every entry has an `id` and a `parentId`,
 * and branching adds a second child to an earlier entry rather than a second
 * file. The active conversation is the path from the current leaf back to the
 * root; everything else is a branch the user can return to.
 *
 * Nothing here touches IPC or React — the tree rail, the inline branch chips,
 * and the message actions all read from these functions.
 */

import type { TreeNode } from "./bridge";

/** Entry types that show up in the transcript, in the order they appear. */
const TRANSCRIPT_TYPES = new Set(["message", "compaction", "branch_summary", "custom_message"]);

export interface ChildIndex {
  /** Children of each entry, in append order. Root children key off `""`. */
  byParent: Map<string, TreeNode[]>;
  byId: Map<string, TreeNode>;
}

export function indexTree(nodes: TreeNode[]): ChildIndex {
  const byParent = new Map<string, TreeNode[]>();
  const byId = new Map<string, TreeNode>();
  for (const node of nodes) {
    byId.set(node.id, node);
    const key = node.parentId ?? "";
    const list = byParent.get(key);
    if (list) list.push(node);
    else byParent.set(key, [node]);
  }
  return { byParent, byId };
}

/**
 * The path from root to `leafId`, in conversation order.
 *
 * With no leaf the session has not been navigated, so the last appended entry
 * is the leaf — that is what the file-based reader reports as `lastEntryId`.
 */
export function activeBranch(nodes: TreeNode[], leafId: string | null | undefined): TreeNode[] {
  if (!leafId) return [];
  const { byId } = indexTree(nodes);
  const path: TreeNode[] = [];
  const guard = new Set<string>();
  let cursor: string | null | undefined = leafId;
  while (cursor) {
    // A corrupt parent chain must not spin forever.
    if (guard.has(cursor)) break;
    guard.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    path.push(node);
    cursor = node.parentId;
  }
  return path.reverse();
}

/** The ids on the active path, for "is this node live?" lookups. */
export function activeIds(nodes: TreeNode[], leafId: string | null | undefined): Set<string> {
  return new Set(activeBranch(nodes, leafId).map((n) => n.id));
}

export interface SiblingInfo {
  /** Every child of this node's parent, in append order. */
  siblings: TreeNode[];
  index: number;
  total: number;
}

/**
 * The branch set this node belongs to. `total > 1` is the whole trigger for
 * showing an inline branch chip: it means an earlier turn was answered more
 * than one way, and both answers are still reachable.
 */
export function siblingInfo(index: ChildIndex, nodeId: string): SiblingInfo | null {
  const node = index.byId.get(nodeId);
  if (!node) return null;
  const siblings = index.byParent.get(node.parentId ?? "") ?? [];
  const at = siblings.findIndex((s) => s.id === nodeId);
  if (at === -1) return null;
  return { siblings, index: at, total: siblings.length };
}

/**
 * The nearest user entry at or above `fromId`.
 *
 * This is what "retry the last turn" targets: navigating to a user entry moves
 * the leaf to that entry's *parent* and hands back its text, so re-sending it
 * creates a sibling branch rather than overwriting anything.
 */
export function nearestUserEntry(nodes: TreeNode[], fromId: string | null | undefined): TreeNode | null {
  const branch = activeBranch(nodes, fromId);
  for (let i = branch.length - 1; i >= 0; i--) {
    const node = branch[i];
    if (node.type === "message" && node.role === "user") return node;
  }
  return null;
}

/** Entries on the branch that the transcript also renders, in order. */
export function transcriptEntries(branch: TreeNode[]): TreeNode[] {
  return branch.filter((n) => {
    if (!TRANSCRIPT_TYPES.has(n.type)) return false;
    // Tool results render as their own transcript rows; bash executions do not
    // reach the transcript at all until the next prompt folds them into context.
    return n.type !== "message" || n.role !== "bashExecution";
  });
}

/**
 * Maps the transcript's user turns onto their session entries, positionally.
 *
 * Events carry no entry ids — `message_end` ships only the message — so the
 * k-th user turn in the transcript is matched to the k-th user entry on the
 * active branch. That holds while the two describe the same conversation, and
 * stops holding after a compaction+resume, where the transcript is rebuilt from
 * post-compaction context while the tree still holds the full history.
 *
 * Returns `null` rather than a wrong guess when the counts disagree; callers
 * fall back to the tree rail, which always has real ids.
 */
export function alignUserEntries(branch: TreeNode[], transcriptUserTexts: string[]): string[] | null {
  const userNodes = branch.filter((n) => n.type === "message" && n.role === "user");
  if (userNodes.length !== transcriptUserTexts.length) return null;
  return userNodes.map((n) => n.id);
}

/** A short, human label for a tree row. */
export function nodeTitle(node: TreeNode): string {
  switch (node.type) {
    case "message":
      switch (node.role) {
        case "user":
          return "you";
        case "assistant":
          return node.model ?? "assistant";
        case "toolResult":
          return node.toolName ?? "tool";
        case "bashExecution":
          return "bash";
        default:
          return node.role ?? "message";
      }
    case "compaction":
      return "compacted";
    case "branch_summary":
      return "branch summary";
    case "model_change":
      return "model";
    case "thinking_level_change":
      return "thinking";
    case "session_info":
      return "renamed";
    case "label":
      return "label";
    case "custom_message":
      return node.customType ?? "extension";
    case "custom":
      return node.customType ?? "extension state";
    default:
      return node.type;
  }
}

/** Filters that mirror pi's own `/tree` view modes. */
export type TreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export function applyFilter(nodes: TreeNode[], filter: TreeFilter): TreeNode[] {
  switch (filter) {
    case "all":
      return nodes;
    case "user-only":
      return nodes.filter((n) => n.type === "message" && n.role === "user");
    case "labeled-only":
      return nodes.filter((n) => n.label !== undefined);
    case "no-tools":
      return nodes.filter((n) => !(n.type === "message" && (n.role === "toolResult" || n.role === "bashExecution")));
    case "default":
    default:
      // Bookkeeping entries carry no conversation; they only add noise to a
      // view whose job is navigation.
      return nodes.filter(
        (n) => n.type !== "custom" && n.type !== "label" && n.type !== "session_info",
      );
  }
}

/**
 * Depth-first walk in append order, so the rail renders parents above children
 * and siblings in the order they were created.
 */
export function walkDepthFirst(nodes: TreeNode[]): Array<{ node: TreeNode; depth: number }> {
  const index = indexTree(nodes);
  const out: Array<{ node: TreeNode; depth: number }> = [];
  const seen = new Set<string>();

  const visit = (node: TreeNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    out.push({ node, depth });
    for (const child of index.byParent.get(node.id) ?? []) visit(child, depth + 1);
  };

  for (const root of index.byParent.get("") ?? []) visit(root, 0);
  // Orphans (a broken parent chain) are still the user's conversation; render
  // them as extra roots rather than dropping them on the floor.
  for (const node of nodes) if (!seen.has(node.id)) visit(node, 0);
  return out;
}

/**
 * Depth for the rail's indent guides: a node only earns an indent step where
 * the conversation actually forked. A linear session renders as a flat list,
 * which is what it is.
 */
export function branchDepth(nodes: TreeNode[]): Map<string, number> {
  const index = indexTree(nodes);
  const depths = new Map<string, number>();
  const visit = (node: TreeNode, depth: number) => {
    depths.set(node.id, depth);
    const children = index.byParent.get(node.id) ?? [];
    const next = children.length > 1 ? depth + 1 : depth;
    for (const child of children) visit(child, next);
  };
  const roots = index.byParent.get("") ?? [];
  for (const root of roots) visit(root, 0);
  for (const node of nodes) if (!depths.has(node.id)) depths.set(node.id, 0);
  return depths;
}
