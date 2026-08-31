/**
 * The harness's own slash commands: extension commands, prompt templates, and
 * skills.
 *
 * The two harnesses disagree about how to publish these. omp pushes an
 * `available_commands_update` event and answers `get_available_commands`; pi
 * emits no event at all and answers `get_commands`. A client that only listens
 * for the event — as this app used to — shows an empty menu on pi and sends
 * every `/command` to the model as prose.
 */

import { BRIDGE_COMMAND_NAMES, rpc, type HarnessCommand } from "../bridge";
import { patchWorkspace } from "./runtime-slice";
import type { CommandsSlice, SliceOf } from "./types";

/** Accepts both the object form and omp's occasional bare-string form. */
export function normalizeCommands(raw: unknown): HarnessCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: HarnessCommand[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (!BRIDGE_COMMAND_NAMES.has(item)) out.push({ name: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name : null;
    if (!name || BRIDGE_COMMAND_NAMES.has(name)) continue;
    const info = row.sourceInfo as Record<string, unknown> | undefined;
    out.push({
      name,
      description: typeof row.description === "string" ? row.description : undefined,
      source: typeof row.source === "string" ? row.source : undefined,
      location:
        typeof row.location === "string"
          ? row.location
          : typeof info?.scope === "string"
            ? info.scope
            : undefined,
      path: typeof row.path === "string" ? row.path : typeof info?.path === "string" ? info.path : undefined,
    });
  }
  return out;
}

export const createCommandsSlice: SliceOf<CommandsSlice> = (set, get) => ({
  async loadCommands() {
    const { runtime, harness, activeWorkspaceId: id } = get();
    if (!id || !runtime || runtime.exited) return;
    const command = harness === "pi" ? rpc.getCommands() : rpc.getAvailableCommands();
    const response = (await get().rawCommand(command)) as
      | { data?: { commands?: unknown } }
      | undefined;
    const commands = normalizeCommands(response?.data?.commands);
    // omp also pushes updates as an event; an empty answer there should not
    // wipe a list the event stream already delivered.
    if (commands.length || harness === "pi") patchWorkspace(set, get, id, { harnessCommands: commands });
  },
});
