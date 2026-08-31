import { describe, expect, it } from "vitest";
import { BRIDGE_PREFIX, bridgeCmd, parseBridgeReply, rpc } from "./bridge";
import { flattenPiTree } from "./store/tree-slice";

describe("bridge reply channel", () => {
  it("reads a reply off the notify frame", () => {
    const message = BRIDGE_PREFIX + JSON.stringify({ v: 1, command: "pd-goto", ok: true, data: { leafId: "abc" } });
    expect(parseBridgeReply(message)).toEqual({ v: 1, command: "pd-goto", ok: true, data: { leafId: "abc" } });
  });

  it("leaves an ordinary notification alone — it belongs to the user", () => {
    expect(parseBridgeReply("Command blocked by user")).toBeNull();
    expect(parseBridgeReply(undefined)).toBeNull();
    expect(parseBridgeReply(`${BRIDGE_PREFIX}not json`)).toBeNull();
  });

  it("builds goto with and without a branch summary", () => {
    expect(bridgeCmd.goto("abc")).toBe("/pd-goto abc");
    expect(bridgeCmd.goto("abc", {})).toBe("/pd-goto abc --summarize");
    expect(bridgeCmd.goto("abc", { customInstructions: "auth" })).toBe("/pd-goto abc --summarize=auth");
  });

  it("clears a label with an empty value", () => {
    expect(bridgeCmd.label("abc", "checkpoint")).toBe("/pd-label abc checkpoint");
    expect(bridgeCmd.label("abc", "")).toBe("/pd-label abc");
  });
});

describe("rpc vocabulary", () => {
  it("attaches images only when there are some", () => {
    expect(rpc.promptWith("hi", [])).toEqual({ type: "prompt", message: "hi" });
    const withImage = rpc.promptWith("what is this", [{ type: "image", data: "AAA", mimeType: "image/png" }], "steer");
    expect(withImage).toEqual({
      type: "prompt",
      message: "what is this",
      images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
      streamingBehavior: "steer",
    });
  });

  it("omits optional arguments rather than sending nulls", () => {
    expect(rpc.compact()).toEqual({ type: "compact" });
    expect(rpc.compact("focus on auth")).toEqual({ type: "compact", message: "focus on auth" });
    expect(rpc.getEntries()).toEqual({ type: "get_entries" });
    expect(rpc.getEntries("abc")).toEqual({ type: "get_entries", since: "abc" });
  });
});

describe("flattenPiTree", () => {
  it("flattens pi's nested get_tree into the shared node shape", () => {
    const nodes = flattenPiTree([
      {
        entry: { type: "message", id: "a1", parentId: null, message: { role: "user", content: "hello" } },
        children: [
          {
            entry: {
              type: "message",
              id: "b2",
              parentId: "a1",
              message: {
                role: "assistant",
                model: "claude-opus-4-8",
                provider: "anthropic",
                content: [
                  { type: "text", text: "hi there" },
                  { type: "toolCall", name: "bash", arguments: {} },
                ],
              },
            },
            children: [],
          },
        ],
        label: "start",
      },
    ]);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ id: "a1", parentId: null, role: "user", preview: "hello", label: "start" });
    expect(nodes[1]).toMatchObject({ id: "b2", parentId: "a1", preview: "hi there", toolCalls: ["bash"] });
  });

  it("normalizes model_change across both harness shapes", () => {
    const pi = flattenPiTree([
      { entry: { type: "model_change", id: "m", parentId: null, provider: "anthropic", modelId: "opus" }, children: [] },
    ]);
    expect(pi[0].preview).toBe("anthropic/opus");
    const omp = flattenPiTree([
      { entry: { type: "model_change", id: "m", parentId: null, model: "openrouter/z-ai/glm" }, children: [] },
    ]);
    expect(omp[0].preview).toBe("openrouter/z-ai/glm");
  });

  it("shrugs off a malformed tree", () => {
    expect(flattenPiTree(null)).toEqual([]);
    expect(flattenPiTree([{ children: [] }, null])).toEqual([]);
  });
});
