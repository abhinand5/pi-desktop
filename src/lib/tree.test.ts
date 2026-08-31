import { describe, expect, it } from "vitest";
import type { TreeNode } from "./bridge";
import {
  activeBranch,
  activeIds,
  alignUserEntries,
  applyFilter,
  branchDepth,
  indexTree,
  nearestUserEntry,
  nodeTitle,
  siblingInfo,
  walkDepthFirst,
} from "./tree";

function node(id: string, parentId: string | null, extra: Partial<TreeNode> = {}): TreeNode {
  return { id, parentId, type: "message", preview: id, ...extra };
}

/**
 *        a1(user)
 *         └ b2(assistant)
 *            ├ c3(user)  ← original path
 *            │  └ d4(assistant)
 *            └ e5(user)  ← the branch, and the live leaf
 *               └ f6(assistant)
 */
const FORKED: TreeNode[] = [
  node("a1", null, { role: "user", preview: "refactor auth" }),
  node("b2", "a1", { role: "assistant", preview: "on it" }),
  node("c3", "b2", { role: "user", preview: "approach A" }),
  node("d4", "c3", { role: "assistant", preview: "doing A" }),
  node("e5", "b2", { role: "user", preview: "approach B" }),
  node("f6", "e5", { role: "assistant", preview: "doing B" }),
];

describe("activeBranch", () => {
  it("walks leaf to root and returns conversation order", () => {
    expect(activeBranch(FORKED, "f6").map((n) => n.id)).toEqual(["a1", "b2", "e5", "f6"]);
    expect(activeBranch(FORKED, "d4").map((n) => n.id)).toEqual(["a1", "b2", "c3", "d4"]);
  });

  it("is empty without a leaf, and survives a broken chain", () => {
    expect(activeBranch(FORKED, null)).toEqual([]);
    expect(activeBranch([node("x", "missing")], "x").map((n) => n.id)).toEqual(["x"]);
  });

  it("does not spin on a cyclic parent chain", () => {
    const cyclic = [node("p", "q"), node("q", "p")];
    expect(activeBranch(cyclic, "p").length).toBe(2);
  });

  it("marks only the live path as active", () => {
    const live = activeIds(FORKED, "f6");
    expect(live.has("e5")).toBe(true);
    expect(live.has("c3")).toBe(false);
  });
});

describe("siblingInfo", () => {
  it("reports the branch set at a fork, which is what earns an inline chip", () => {
    const index = indexTree(FORKED);
    expect(siblingInfo(index, "c3")).toMatchObject({ index: 0, total: 2 });
    expect(siblingInfo(index, "e5")).toMatchObject({ index: 1, total: 2 });
  });

  it("reports a lone child as a set of one, so no chip is shown", () => {
    expect(siblingInfo(indexTree(FORKED), "b2")).toMatchObject({ index: 0, total: 1 });
  });

  it("treats roots as siblings of each other", () => {
    const two = [node("r1", null), node("r2", null)];
    expect(siblingInfo(indexTree(two), "r2")).toMatchObject({ index: 1, total: 2 });
  });
});

describe("nearestUserEntry", () => {
  it("finds the prompt that drove the current leaf — the retry target", () => {
    expect(nearestUserEntry(FORKED, "f6")?.id).toBe("e5");
    expect(nearestUserEntry(FORKED, "d4")?.id).toBe("c3");
  });

  it("returns null when the branch has no user turn", () => {
    expect(nearestUserEntry([node("m1", null, { type: "model_change", role: undefined })], "m1")).toBeNull();
  });
});

describe("alignUserEntries", () => {
  it("maps transcript turns onto entry ids when they describe the same conversation", () => {
    const branch = activeBranch(FORKED, "f6");
    expect(alignUserEntries(branch, ["refactor auth", "approach B"])).toEqual(["a1", "e5"]);
  });

  it("refuses to guess when the counts disagree", () => {
    const branch = activeBranch(FORKED, "f6");
    // What a post-compaction resume looks like: the transcript was rebuilt from
    // context and lost an earlier turn the tree still holds.
    expect(alignUserEntries(branch, ["approach B"])).toBeNull();
  });
});

describe("applyFilter", () => {
  const mixed: TreeNode[] = [
    node("u", null, { role: "user" }),
    node("a", "u", { role: "assistant" }),
    node("t", "a", { role: "toolResult", toolName: "bash" }),
    node("l", "t", { type: "label", role: undefined }),
    node("k", "t", { role: "user", label: "checkpoint" }),
  ];

  it("hides bookkeeping by default but keeps the conversation", () => {
    expect(applyFilter(mixed, "default").map((n) => n.id)).toEqual(["u", "a", "t", "k"]);
  });

  it("drops tool rows for no-tools and keeps only prompts for user-only", () => {
    expect(applyFilter(mixed, "no-tools").map((n) => n.id)).toEqual(["u", "a", "l", "k"]);
    expect(applyFilter(mixed, "user-only").map((n) => n.id)).toEqual(["u", "k"]);
  });

  it("keeps everything for all, and only bookmarks for labeled-only", () => {
    expect(applyFilter(mixed, "all")).toHaveLength(5);
    expect(applyFilter(mixed, "labeled-only").map((n) => n.id)).toEqual(["k"]);
  });
});

describe("walkDepthFirst", () => {
  it("renders parents above children and siblings in append order", () => {
    expect(walkDepthFirst(FORKED).map((r) => r.node.id)).toEqual(["a1", "b2", "c3", "d4", "e5", "f6"]);
  });

  it("surfaces orphans as extra roots instead of dropping them", () => {
    const orphaned = [...FORKED, node("z9", "gone", { role: "user" })];
    expect(walkDepthFirst(orphaned).map((r) => r.node.id)).toContain("z9");
  });
});

describe("branchDepth", () => {
  it("indents only where the conversation actually forked", () => {
    const depth = branchDepth(FORKED);
    expect(depth.get("a1")).toBe(0);
    expect(depth.get("b2")).toBe(0);
    // b2 has two children, so both branches step in.
    expect(depth.get("c3")).toBe(1);
    expect(depth.get("e5")).toBe(1);
  });

  it("leaves a linear session flat", () => {
    const linear = [node("a", null), node("b", "a"), node("c", "b")];
    expect([...branchDepth(linear).values()]).toEqual([0, 0, 0]);
  });
});

describe("nodeTitle", () => {
  it("names rows by what they are to the reader", () => {
    expect(nodeTitle(node("x", null, { role: "user" }))).toBe("you");
    expect(nodeTitle(node("x", null, { role: "toolResult", toolName: "bash" }))).toBe("bash");
    expect(nodeTitle(node("x", null, { role: "assistant", model: "claude-opus-4-8" }))).toBe("claude-opus-4-8");
    expect(nodeTitle(node("x", null, { type: "branch_summary", role: undefined }))).toBe("branch summary");
  });
});
