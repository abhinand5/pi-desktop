import { describe, expect, it, vi } from "vitest";
import {
  builtinCommands,
  createRegistry,
  harnessCommands,
  parseSlashInvocation,
  type CommandContext,
  type DesktopActions,
} from "./commands";
import { normalizeCommands } from "./store/commands-slice";

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  active: true,
  streaming: false,
  hasSession: true,
  hasTree: true,
  bridgeReady: true,
  ...over,
});

const actions = (): DesktopActions =>
  Object.fromEntries(
    ["compact", "newSession", "rename", "export", "openTree", "openStatus", "openTerminal", "openProviders", "retryLast", "copyLast", "fork", "clone", "abort"].map(
      (k) => [k, vi.fn()],
    ),
  ) as unknown as DesktopActions;

describe("parseSlashInvocation", () => {
  it("splits the name from the rest of the line", () => {
    expect(parseSlashInvocation("/name my session")).toEqual({ name: "name", args: "my session" });
    expect(parseSlashInvocation("/compact")).toEqual({ name: "compact", args: "" });
  });

  it("keeps colons so skills survive", () => {
    expect(parseSlashInvocation("/skill:web-search find X")).toEqual({
      name: "skill:web-search",
      args: "find X",
    });
  });

  it("is not fooled by prose that merely starts with a slash", () => {
    expect(parseSlashInvocation("/ leading space")).toBeNull();
    expect(parseSlashInvocation("not a command")).toBeNull();
    expect(parseSlashInvocation("//escaped")).toBeNull();
  });
});

describe("registry", () => {
  it("hides commands that cannot run right now instead of failing later", () => {
    const registry = createRegistry([builtinCommands(actions())]);
    const idle = registry.list(ctx({ streaming: false })).map((c) => c.name);
    expect(idle).toContain("compact");
    expect(idle).not.toContain("stop");

    const busy = registry.list(ctx({ streaming: true })).map((c) => c.name);
    expect(busy).toContain("stop");
    expect(busy).not.toContain("compact");
  });

  it("hides retry when the bridge did not load, since branching needs it", () => {
    const registry = createRegistry([builtinCommands(actions())]);
    expect(registry.list(ctx({ bridgeReady: false })).map((c) => c.name)).not.toContain("retry");
  });

  it("lets a desktop verb win over a same-named harness command", () => {
    const registry = createRegistry([
      builtinCommands(actions()),
      harnessCommands([{ name: "compact", description: "an extension's own compact" }]),
    ]);
    const matches = registry.list(ctx()).filter((c) => c.name === "compact");
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("desktop");
  });

  it("ranks an exact prefix above a description hit", () => {
    const registry = createRegistry([builtinCommands(actions())]);
    expect(registry.match("com", ctx())[0].name).toBe("compact");
  });

  it("passes harness commands through untouched — the agent owns that namespace", async () => {
    const registry = createRegistry([harnessCommands([{ name: "fix-tests", source: "prompt" }])]);
    const command = registry.find("fix-tests", ctx());
    expect(command?.source).toBe("prompt");
    expect(await command?.run("", ctx())).toEqual({ kind: "passthrough" });
  });

  it("reports a usage error rather than renaming to nothing", async () => {
    const registry = createRegistry([builtinCommands(actions())]);
    expect(await registry.find("name", ctx())?.run("", ctx())).toMatchObject({ kind: "error" });
  });
});

describe("normalizeCommands", () => {
  it("reads pi's object form, including sourceInfo provenance", () => {
    expect(
      normalizeCommands([
        { name: "fix-tests", description: "Fix failing tests", source: "prompt", sourceInfo: { scope: "project", path: "/p/f.md" } },
      ]),
    ).toEqual([
      { name: "fix-tests", description: "Fix failing tests", source: "prompt", location: "project", path: "/p/f.md" },
    ]);
  });

  it("reads a bare string list too", () => {
    expect(normalizeCommands(["alpha", "beta"]).map((c) => c.name)).toEqual(["alpha", "beta"]);
  });

  it("keeps the desktop's own bridge commands out of the user's menu", () => {
    expect(normalizeCommands([{ name: "pd-goto" }, { name: "pd-tree" }, { name: "real" }]).map((c) => c.name)).toEqual([
      "real",
    ]);
  });

  it("shrugs off junk", () => {
    expect(normalizeCommands(null)).toEqual([]);
    expect(normalizeCommands([null, 42, { nope: true }])).toEqual([]);
  });
});
