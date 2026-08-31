import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, GitBranch, Pencil, RotateCw } from "lucide-react";
import { useAppStore } from "../lib/agent-store";
import { indexTree, siblingInfo } from "../lib/tree";

/** Copy, with the confirmation the click earns. */
export function CopyButton({ text, label = "Copy message" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <ActionButton
      label={copied ? "Copied" : label}
      disabled={!text.trim()}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        timer.current = setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </ActionButton>
  );
}

export function ActionButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-control-sm w-control-sm items-center justify-center rounded-sm text-ink-faint hover:bg-ink-2 hover:text-ink-text disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/**
 * Actions on a user turn.
 *
 * Retry and edit both work the same way: move the leaf to this prompt's parent,
 * then send again. The original answer stays reachable as a sibling branch
 * rather than being overwritten — which is the whole point of a tree.
 */
export function UserMessageActions({ text, entryId }: { text: string; entryId: string | null }) {
  const retryEntry = useAppStore((s) => s.retryEntry);
  const gotoEntry = useAppStore((s) => s.gotoEntry);
  const forkFrom = useAppStore((s) => s.forkFrom);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const bridgeReady = useAppStore((s) => s.bridgeReady);
  const streaming = useAppStore((s) => s.agent.streaming);

  const canBranch = entryId !== null && bridgeReady && !streaming;

  return (
    <div className="row-actions flex items-center gap-0.5">
      <CopyButton text={text} />
      <ActionButton
        label={canBranch ? "Edit and send again as a new branch" : "Editing needs the session bridge"}
        disabled={!canBranch}
        onClick={() => {
          if (!entryId) return;
          void gotoEntry(entryId).then((restored) => setComposerDraft(restored ?? text));
        }}
      >
        <Pencil size={12} />
      </ActionButton>
      <ActionButton
        label={canBranch ? "Send this prompt again as a new branch" : "Retry needs the session bridge"}
        disabled={!canBranch}
        onClick={() => entryId && void retryEntry(entryId, text)}
      >
        <RotateCw size={12} />
      </ActionButton>
      <ActionButton
        label="Start a separate session from this prompt"
        disabled={entryId === null || streaming}
        onClick={() => entryId && void forkFrom(entryId)}
      >
        <GitBranch size={12} />
      </ActionButton>
    </div>
  );
}

export function AssistantMessageActions({ text }: { text: string }) {
  const setPanel = useAppStore((s) => s.setPanel);
  return (
    <div className="row-actions flex items-center gap-0.5">
      <CopyButton text={text} label="Copy response" />
      <ActionButton label="Show this turn in the conversation tree" onClick={() => setPanel("tree")}>
        <GitBranch size={12} />
      </ActionButton>
    </div>
  );
}

/**
 * The one always-visible sign that a tree exists.
 *
 * Shown only where a prompt was actually answered more than one way, so a
 * linear conversation stays free of tree furniture. The arrows switch branches
 * in place; the label opens the full rail.
 */
export function BranchChip({ entryId }: { entryId: string }) {
  const tree = useAppStore((s) => s.tree);
  const gotoEntry = useAppStore((s) => s.gotoEntry);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const setPanel = useAppStore((s) => s.setPanel);
  const streaming = useAppStore((s) => s.agent.streaming);

  const nodes = tree?.nodes ?? [];
  const info = nodes.length ? siblingInfo(indexTree(nodes), entryId) : null;
  if (!info || info.total < 2) return null;

  const jump = (delta: number) => {
    const next = info.siblings[(info.index + delta + info.total) % info.total];
    void gotoEntry(next.id).then((restored) => {
      if (restored) setComposerDraft(restored);
    });
  };

  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-line bg-ink-1 py-0.5 pr-1 pl-1">
      <button
        onClick={() => jump(-1)}
        disabled={streaming}
        aria-label="Previous branch"
        className="flex h-4 w-4 items-center justify-center rounded-full text-ink-faint hover:text-amber disabled:opacity-30"
      >
        <ChevronLeft size={11} />
      </button>
      <button
        onClick={() => setPanel("tree")}
        className="px-1 font-mono text-2xs text-ink-dim hover:text-ink-text"
        title="Open the conversation tree"
      >
        branch {info.index + 1}/{info.total}
      </button>
      <button
        onClick={() => jump(1)}
        disabled={streaming}
        aria-label="Next branch"
        className="flex h-4 w-4 items-center justify-center rounded-full text-ink-faint hover:text-amber disabled:opacity-30"
      >
        <ChevronRight size={11} />
      </button>
    </div>
  );
}
