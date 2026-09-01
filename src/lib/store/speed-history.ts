/**
 * Measured turns, remembered per session.
 *
 * Throughput is something this app observes rather than something the harness
 * records — the session file has timestamps but no separation of prompt
 * processing from generation, and no notion of the gaps where a tool was
 * running. So the measurements are ours to keep, and if we do not keep them,
 * resuming a session with twenty turns behind it reports an average over the
 * one turn you have run since opening the app.
 *
 * Keyed by session file, so resuming a session gets its own history back and a
 * new session starts empty. Turns run in the TUI are not here, and cannot be:
 * nothing timed them.
 */

import type { SpeedSample } from "../speed";

const KEY = "pi-desktop.speed";
/** Enough for a long session; a mean over 300 turns is not improved by 3000. */
const MAX_SAMPLES = 300;
/** Sessions to remember at all, most recently written first. */
const MAX_SESSIONS = 40;

interface Stored {
  version: 1;
  sessions: Array<{ path: string; samples: SpeedSample[] }>;
}

function read(): Stored {
  if (typeof window === "undefined") return { version: 1, sessions: [] };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { version: 1, sessions: [] };
    const parsed = JSON.parse(raw) as Stored;
    if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) return { version: 1, sessions: [] };
    return parsed;
  } catch {
    return { version: 1, sessions: [] };
  }
}

export function loadSpeedHistory(sessionFile: string | null): SpeedSample[] {
  if (!sessionFile) return [];
  const entry = read().sessions.find((s) => s.path === sessionFile);
  return Array.isArray(entry?.samples) ? entry.samples : [];
}

export function saveSpeedHistory(sessionFile: string | null, samples: SpeedSample[]): void {
  if (!sessionFile || typeof window === "undefined") return;
  const stored = read();
  const rest = stored.sessions.filter((s) => s.path !== sessionFile);
  const next: Stored = {
    version: 1,
    // Most recently written first, so the trim drops the sessions you have not
    // touched in longest.
    sessions: [{ path: sessionFile, samples: samples.slice(-MAX_SAMPLES) }, ...rest].slice(0, MAX_SESSIONS),
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a full or blocked store is not worth failing a turn over */
  }
}

/** Drops a session's measurements, for when its file is deleted. */
export function forgetSpeedHistory(sessionFile: string): void {
  if (typeof window === "undefined") return;
  const stored = read();
  const sessions = stored.sessions.filter((s) => s.path !== sessionFile);
  if (sessions.length === stored.sessions.length) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ version: 1, sessions }));
  } catch {
    /* nothing to do */
  }
}
