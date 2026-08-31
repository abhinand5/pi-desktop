/**
 * Request/response over the bridge extension.
 *
 * The harnesses expose no RPC command for session-tree navigation, so the
 * desktop drives a bundled extension instead: the request goes out as an
 * ordinary `prompt` carrying `/pd-…`, and the answer arrives asynchronously as
 * a `notify` frame on the event stream. This module pairs the two back up.
 *
 * Extension commands execute immediately even while the agent is streaming, so
 * a tree read never has to wait for a turn to finish.
 */

import type { BridgeReply, BridgeReplyCommand } from "../bridge";

type Waiter = {
  resolve: (reply: BridgeReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** FIFO per command: replies carry no request id, so the oldest wins. */
const waiters = new Map<BridgeReplyCommand, Waiter[]>();

/** Routes a parsed reply to whoever asked. Returns false if nobody did, which
 *  is normal for the state pings the store fires after every turn. */
export function deliverBridgeReply(reply: BridgeReply): boolean {
  const queue = waiters.get(reply.command);
  const waiter = queue?.shift();
  if (!waiter) return false;
  clearTimeout(waiter.timer);
  waiter.resolve(reply);
  return true;
}

/** Fails every outstanding call — used when a runtime dies mid-flight. */
export function cancelBridgeCalls(reason: string): void {
  for (const queue of waiters.values()) {
    for (const waiter of queue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
  }
  waiters.clear();
}

export class BridgeUnavailableError extends Error {}

/**
 * Sends a bridge command and waits for its reply.
 *
 * A timeout here almost always means the extension did not load, so the caller
 * turns off in-place branching rather than leaving the UI hanging.
 */
export async function callBridge(
  send: (promptText: string) => Promise<unknown>,
  command: BridgeReplyCommand,
  promptText: string,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const pending = new Promise<BridgeReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      const queue = waiters.get(command);
      const at = queue?.findIndex((w) => w.timer === timer) ?? -1;
      if (queue && at !== -1) queue.splice(at, 1);
      reject(new BridgeUnavailableError(`the session bridge did not answer /${command}`));
    }, timeoutMs);
    const queue = waiters.get(command) ?? [];
    queue.push({ resolve, reject, timer });
    waiters.set(command, queue);
  });

  try {
    await send(promptText);
  } catch (e) {
    // The prompt itself was rejected; drop the waiter rather than let it age out.
    const queue = waiters.get(command);
    if (queue?.length) {
      const waiter = queue.pop();
      if (waiter) clearTimeout(waiter.timer);
    }
    throw e;
  }

  const reply = await pending;
  if (!reply.ok) {
    throw new Error(String(reply.data?.error ?? `/${command} failed`));
  }
  return reply.data ?? {};
}
