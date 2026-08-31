/**
 * Turns transport and harness failures into something a person can act on.
 *
 * The Rust bridge surfaces its errors verbatim — "spawn failed: No such file or
 * directory (os error 2)" is accurate and useless. Each case here says what
 * went wrong and what to do about it, in the interface's voice.
 */

import type { HarnessId } from "./bridge";

const HOME: Record<HarnessId, string> = { pi: "~/.pi/agent", omp: "~/.omp/agent" };

export function describeRuntimeError(error: unknown, harness: HarnessId, host: string | null): string {
  const raw = String((error as { message?: string })?.message ?? error);

  if (/BinaryNotFound|No such file or directory|not found/i.test(raw)) {
    return host
      ? `${harness} is not installed on ${host}. Install it there, or use Bootstrap to push it over the connection.`
      : `${harness} is not on your PATH. Install it, then start the session again.`;
  }
  if (/Permission denied|publickey|Host key verification/i.test(raw)) {
    return `${host ?? "The host"} refused the connection. pi-desktop connects with key auth only — check that your key is authorized there.`;
  }
  if (/Connection refused|Could not resolve|No route to host|timed out/i.test(raw)) {
    return `Could not reach ${host ?? "the host"}. Check the address and that the machine is up.`;
  }
  return raw;
}

/** Turn-level failures arrive inside the transcript, not as spawn errors. */
export function describeTurnError(message: string, harness: HarnessId): { title: string; detail: string; hint?: string } {
  if (/OAuth|refresh token|expired|401|unauthorized|api key/i.test(message)) {
    return {
      title: "Sign in again",
      detail: message,
      hint: `Credentials belong to ${harness}, not to pi-desktop. Run \`${harness}\` once in a terminal and sign in there — this app picks the same credentials up from ${HOME[harness]}.`,
    };
  }
  if (/rate limit|429|quota|overloaded/i.test(message)) {
    return {
      title: "The provider is rate limiting",
      detail: message,
      hint: "Wait a moment and retry the turn, or switch to another model.",
    };
  }
  if (/context|too long|maximum.*tokens/i.test(message)) {
    return {
      title: "The conversation outgrew the context window",
      detail: message,
      hint: "Compact the session, or branch from an earlier point in the tree.",
    };
  }
  return { title: "The turn failed", detail: message };
}
