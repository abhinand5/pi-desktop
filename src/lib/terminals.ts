/**
 * Live terminals, kept outside React.
 *
 * A terminal is a running process with scrollback, a cursor, and a shell that
 * has your history and your half-typed command in it. Unmounting one because
 * you looked at another workspace would throw all of that away, so the emulator
 * and its DOM node live here for as long as the process does, and the component
 * only borrows the node.
 *
 * This is the same promise the chat side makes — leave a turn generating,
 * switch away, come back to it — applied to a build that is still running.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { bridge, type PtyInfo, type PtyProgram } from "./bridge";

export interface TerminalSession {
  /** The workspace this belongs to. */
  workspaceId: string;
  term: Terminal;
  fit: FitAddon;
  /** Reparented between mounts, never rebuilt. */
  element: HTMLDivElement;
  pty: PtyInfo | null;
  /** Set when the process ended, so the view can say so instead of looking hung. */
  exit: { code: number | null } | null;
  error: string | null;
  /** Bumped on exit or error so a mounted view re-renders. */
  onChange: Set<() => void>;
  disposed: boolean;
}

const sessions = new Map<string, TerminalSession>();

export function getTerminal(workspaceId: string): TerminalSession | undefined {
  return sessions.get(workspaceId);
}

/**
 * The palette, read from the document rather than duplicated here.
 *
 * The app's themes are custom properties on the root, so the terminal picks up
 * a theme change by reading the same values everything else does. The ANSI
 * sixteen are the one thing a palette does not already define — a terminal
 * needs distinguishable red/green/yellow/blue in a way a UI does not — so they
 * are anchored to the palette's semantic colours where those exist and filled
 * in around them.
 */
export function terminalTheme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;

  const bg = v("--color-ink-0", "#0e1116");
  const fg = v("--color-ink-text", "#d9dde2");
  const dim = v("--color-ink-dim", "#8a93a0");
  const faint = v("--color-ink-faint", "#5b6470");
  const accent = v("--color-amber", "#e8a33d");
  const teal = v("--color-teal", "#6fb3c0");
  const green = v("--color-green", "#7fb685");
  const red = v("--color-red", "#e06c5f");

  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: v("--color-ink-3", "#222a34"),
    black: v("--color-ink-2", "#1b2129"),
    red,
    green,
    yellow: accent,
    blue: teal,
    magenta: "#b18ad0",
    cyan: teal,
    white: dim,
    brightBlack: faint,
    brightRed: red,
    brightGreen: green,
    brightYellow: accent,
    brightBlue: teal,
    brightMagenta: "#c9a5e0",
    brightCyan: teal,
    brightWhite: fg,
  };
}

/**
 * The terminal's font stack.
 *
 * `--font-terminal`, not `--font-mono`: a harness TUI draws its chrome from
 * Nerd Font glyphs, and the terminal stack puts a Nerd Font *Mono* first so
 * those land in one cell instead of falling back to a font with no such glyph
 * and different metrics.
 */
function terminalFont(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim() ||
    "ui-monospace, monospace"
  );
}

/**
 * Re-reads the palette and the font for every live terminal.
 *
 * Both come from custom properties on the root, so a theme or font change is
 * picked up by re-reading rather than by rebuilding — scrollback and the
 * running process survive it.
 */
export function restyle(): void {
  const theme = terminalTheme();
  const font = terminalFont();
  for (const s of sessions.values()) {
    s.term.options.theme = theme;
    if (s.term.options.fontFamily !== font) {
      s.term.options.fontFamily = font;
      // The cell size changed with the font, so the geometry the shell was
      // told about is now wrong.
      if (s.element.clientWidth > 0) s.fit.fit();
    }
  }
}

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Creates the emulator and starts the process behind it.
 *
 * Returns immediately with a session whose `pty` fills in once the backend
 * answers; the emulator is usable (and shows the failure, if there is one)
 * either way.
 */
export function openTerminal(init: {
  workspaceId: string;
  program: PtyProgram;
  cwd: string;
  host: string | null;
}): TerminalSession {
  const existing = sessions.get(init.workspaceId);
  if (existing) return existing;

  const element = document.createElement("div");
  element.style.width = "100%";
  element.style.height = "100%";

  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: terminalFont(),
    fontSize: 13,
    // Exactly 1, which is not a readability choice. Box-drawing rules, block
    // characters, and powerline separators are drawn to fill their cell edge to
    // edge; any leading breaks a TUI's borders into dashes and leaves a band
    // through its solid fills.
    lineHeight: 1,
    cursorBlink: true,
    // Enough that a long build's output is still there when you come back.
    scrollback: 10_000,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  const session: TerminalSession = {
    workspaceId: init.workspaceId,
    term,
    fit,
    element,
    pty: null,
    exit: null,
    error: null,
    onChange: new Set(),
    disposed: false,
  };
  sessions.set(init.workspaceId, session);

  const changed = () => session.onChange.forEach((fn) => fn());

  void bridge
    .openPty({
      program: init.program,
      cwd: init.cwd,
      host: init.host,
      cols: term.cols,
      rows: term.rows,
      onEvent: (ev) => {
        if (session.disposed) return;
        if (ev.type === "output") {
          term.write(fromBase64(ev.data));
        } else if (ev.type === "exit") {
          session.exit = { code: ev.code };
          changed();
        } else {
          session.error = ev.message;
          changed();
        }
      },
    })
    .then((pty) => {
      if (session.disposed) {
        void bridge.killPty(pty.id);
        return;
      }
      session.pty = pty;
      changed();
      // The emulator may have been fitted to a real size while the process was
      // starting, so tell the pty what it actually is.
      void bridge.resizePty(pty.id, term.cols, term.rows);
    })
    .catch((e: unknown) => {
      session.error = String(e);
      // Written into the terminal too: that is where the eye already is.
      term.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`);
      changed();
    });

  term.onData((data) => {
    if (session.pty) void bridge.writePty(session.pty.id, toBase64(encoder.encode(data)));
  });
  term.onResize(({ cols, rows }) => {
    if (session.pty) void bridge.resizePty(session.pty.id, cols, rows);
  });

  return session;
}

/** Ends the process and disposes the emulator. */
export function closeTerminal(workspaceId: string): void {
  const session = sessions.get(workspaceId);
  if (!session) return;
  session.disposed = true;
  sessions.delete(workspaceId);
  if (session.pty) void bridge.killPty(session.pty.id);
  session.term.dispose();
}

/** Restarts a terminal in place, after its process exited. */
export function restartTerminal(init: {
  workspaceId: string;
  program: PtyProgram;
  cwd: string;
  host: string | null;
}): TerminalSession {
  closeTerminal(init.workspaceId);
  return openTerminal(init);
}
