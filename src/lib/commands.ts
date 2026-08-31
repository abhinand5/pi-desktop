/**
 * The composer's slash-command registry.
 *
 * Providers contribute commands; the registry knows nothing about what any of
 * them mean. That split is what lets a command disappear when it cannot run —
 * no session, nothing to export — rather than failing after it is picked.
 *
 * Three providers, in menu order:
 *   builtin  — desktop verbs, executed over RPC
 *   harness  — the agent's own extension commands, prompt templates, and skills
 *   fallback — anything else, passed through untouched
 */

import type { HarnessCommand } from "./bridge";

export type CommandSource = "desktop" | "extension" | "prompt" | "skill" | "harness";

export interface CommandContext {
  active: boolean;
  streaming: boolean;
  hasSession: boolean;
  hasTree: boolean;
  bridgeReady: boolean;
}

export type CommandOutcome =
  | { kind: "handled" }
  /** Replace the composer's text — used by templates and by tree jumps. */
  | { kind: "set-input"; input: string }
  /** Not ours: hand the raw line to the harness, which owns the namespace. */
  | { kind: "passthrough" }
  | { kind: "error"; message: string };

export interface Command {
  id: string;
  name: string;
  title: string;
  description: string;
  source: CommandSource;
  /** Hidden rather than disabled when it cannot run right now. */
  when?: (ctx: CommandContext) => boolean;
  run: (args: string, ctx: CommandContext) => CommandOutcome | Promise<CommandOutcome>;
}

export interface SlashInvocation {
  name: string;
  args: string;
}

/** `/name rest of the line`. Names may contain `:` for skills (`skill:web`). */
export function parseSlashInvocation(input: string): SlashInvocation | null {
  const match = /^\/([\w][\w.:-]*)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

/** Actions the builtin commands need. Anything absent hides its command. */
export interface DesktopActions {
  compact: (instructions?: string) => void;
  newSession: () => void;
  rename: (name: string) => void;
  export: () => void;
  openTree: () => void;
  openStatus: () => void;
  openTerminal: () => void;
  openProviders: () => void;
  retryLast: () => void;
  copyLast: () => void;
  fork: () => void;
  clone: () => void;
  abort: () => void;
}

export function builtinCommands(actions: DesktopActions): Command[] {
  const desktop = (
    name: string,
    title: string,
    description: string,
    run: (args: string) => CommandOutcome | Promise<CommandOutcome>,
    when?: Command["when"],
  ): Command => ({
    id: `desktop:${name}`,
    name,
    title,
    description,
    source: "desktop",
    when,
    run: (args) => run(args),
  });

  const act = (fn: () => void): CommandOutcome => {
    fn();
    return { kind: "handled" };
  };
  const live = (ctx: CommandContext) => ctx.active;

  return [
    desktop("tree", "Tree", "Show the conversation tree and jump to any point", () => act(actions.openTree), (c) => c.hasTree),
    desktop(
      "retry",
      "Retry",
      "Run the last prompt again as a new branch",
      () => act(actions.retryLast),
      (c) => c.active && !c.streaming && c.bridgeReady,
    ),
    desktop("compact", "Compact", "Summarize older context to free up the window", (args) =>
      act(() => actions.compact(args || undefined)), (c) => c.active && !c.streaming),
    desktop("new", "New session", "Start a fresh session in this project", () => act(actions.newSession), live),
    desktop("name", "Rename", "Give this session a name you will recognize", (args) =>
      args ? act(() => actions.rename(args)) : { kind: "error", message: "Usage: /name <session name>" }, live),
    desktop("export", "Export", "Save this session as an HTML file", () => act(actions.export), live),
    desktop("fork", "Fork", "Start a separate session from the last prompt", () => act(actions.fork), live),
    desktop("clone", "Clone", "Copy this branch into a separate session", () => act(actions.clone), live),
    desktop("copy", "Copy reply", "Copy the agent's last message", () => act(actions.copyLast), live),
    desktop("status", "Status", "Show tokens, cost, and context usage", () => act(actions.openStatus), live),
    desktop("terminal", "Terminal", "Run a shell command in the agent's context", () => act(actions.openTerminal), live),
    desktop("models", "Endpoints & models", "Manage providers and model catalogs", () => act(actions.openProviders)),
    desktop("stop", "Stop", "Interrupt the running turn", () => act(actions.abort), (c) => c.streaming),
  ];
}

/**
 * The harness's own commands. `send` hands the raw `/name args` line back to
 * the agent, which expands templates and skills itself.
 */
export function harnessCommands(commands: HarnessCommand[]): Command[] {
  return commands.map((command) => ({
    id: `harness:${command.name}`,
    name: command.name,
    title: command.name,
    description: command.description ?? describeSource(command),
    source: (command.source as CommandSource) ?? "harness",
    when: (ctx: CommandContext) => ctx.active,
    run: () => ({ kind: "passthrough" as const }),
  }));
}

function describeSource(command: HarnessCommand): string {
  switch (command.source) {
    case "prompt":
      return `Prompt template${command.location ? ` · ${command.location}` : ""}`;
    case "skill":
      return `Skill${command.location ? ` · ${command.location}` : ""}`;
    case "extension":
      return "Extension command";
    default:
      return "Provided by the agent";
  }
}

export interface Registry {
  list(ctx: CommandContext): Command[];
  find(name: string, ctx: CommandContext): Command | null;
  match(query: string, ctx: CommandContext, limit?: number): Command[];
}

export function createRegistry(groups: Command[][]): Registry {
  const list = (ctx: CommandContext): Command[] => {
    const seen = new Set<string>();
    const out: Command[] = [];
    for (const group of groups) {
      for (const command of group) {
        const key = command.name.toLowerCase();
        // First provider wins: a desktop verb is not silently shadowed by a
        // same-named prompt template.
        if (seen.has(key)) continue;
        if (command.when && !command.when(ctx)) continue;
        seen.add(key);
        out.push(command);
      }
    }
    return out;
  };

  return {
    list,
    find: (name, ctx) => {
      const key = name.toLowerCase();
      return list(ctx).find((c) => c.name.toLowerCase() === key) ?? null;
    },
    match: (query, ctx, limit = 8) => {
      const all = list(ctx);
      const q = query.trim().toLowerCase();
      // An empty query keeps provider order so desktop verbs lead the menu.
      if (!q) return all.slice(0, limit);
      const scored = all
        .map((command) => ({ command, score: score(command, q) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
      return scored.slice(0, limit).map((row) => row.command);
    },
  };
}

/** Prefix beats word-start beats substring; the name beats the description. */
function score(command: Command, query: string): number {
  const name = command.name.toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 50;
  if (command.title.toLowerCase().includes(query)) return 30;
  if (command.description.toLowerCase().includes(query)) return 10;
  return 0;
}
