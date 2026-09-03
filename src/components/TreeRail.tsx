import { useEffect, useMemo, useState } from "react";
import { Bookmark, Filter, RefreshCw, X } from "lucide-react";
import { useAppStore } from "../lib/agent-store";
import type { TreeNode } from "../lib/bridge";
import {
  activeIds,
  applyFilter,
  branchDepth,
  indexTree,
  nodeTitle,
  walkDepthFirst,
  type TreeFilter,
} from "../lib/tree";

const FILTERS: TreeFilter[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

/** Horizontal step per branch level. */
const INDENT = 14;

/**
 * The conversation tree.
 *
 * pi and omp keep alternative answers in one session file rather than forking a
 * new one per attempt, so every path the conversation has taken is still here.
 * The live path is drawn in amber; everything else is a branch to return to.
 *
 * Opened on demand — a linear conversation needs no map.
 */
export default function TreeRail() {
  const open = useAppStore((s) => s.openPanel === "tree");
  const setPanel = useAppStore((s) => s.setPanel);
  const tree = useAppStore((s) => s.tree);
  const leafId = useAppStore((s) => s.leafId);
  const loading = useAppStore((s) => s.treeLoading);
  const error = useAppStore((s) => s.treeError);
  const bridgeReady = useAppStore((s) => s.bridgeReady);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const gotoEntry = useAppStore((s) => s.gotoEntry);
  const labelEntry = useAppStore((s) => s.labelEntry);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const setSelectedNode = useAppStore((s) => s.setSelectedNode);
  const summarize = useAppStore((s) => s.settings.summarizeOnJump);
  const setSetting = useAppStore((s) => s.setSetting);

  const [filter, setFilter] = useState<TreeFilter>("default");

  const nodes = useMemo(() => tree?.nodes ?? [], [tree]);
  const live = useMemo(() => activeIds(nodes, leafId), [nodes, leafId]);
  const depths = useMemo(() => branchDepth(nodes), [nodes]);
  const forks = useMemo(() => {
    const index = indexTree(nodes);
    return new Set(
      [...index.byParent.entries()].filter(([, kids]) => kids.length > 1).map(([id]) => id),
    );
  }, [nodes]);

  const rows = useMemo(() => {
    const visible = new Set(applyFilter(nodes, filter).map((n) => n.id));
    return walkDepthFirst(nodes).filter((r) => visible.has(r.node.id));
  }, [nodes, filter]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setPanel]);

  if (!open) return null;

  const jump = async (node: TreeNode) => {
    setSelectedNode(node.id);
    const restored = await gotoEntry(node.id, summarize ? { summarize: true } : undefined);
    // A prompt comes back for editing; anything else just moves the leaf.
    if (restored) setComposerDraft(restored);
  };

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-ink-1">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="eyebrow font-mono text-2xs tracking-wider text-ink-dim uppercase">conversation tree</span>
        <button
          onClick={() => void refreshTree()}
          aria-label="Reload the tree"
          className="ml-auto text-ink-faint hover:text-ink-text"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
        <button onClick={() => setPanel(null)} aria-label="Close the tree" className="text-ink-faint hover:text-ink-text">
          <X size={14} />
        </button>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-3 py-2">
        <Filter size={10} className="text-ink-faint" />
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-1.5 py-0.5 font-mono text-2xs ${
              filter === f ? "border-line-strong bg-ink-3 text-ink-text" : "border-transparent text-ink-faint hover:text-ink-dim"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {!bridgeReady ? (
        <p className="border-b border-line px-3 py-2 text-sm text-ink-dim">
          Jumping is unavailable — the session bridge did not load, so this is a read-only view.
        </p>
      ) : null}
      {error ? <p className="border-b border-line px-3 py-2 text-sm text-red">{error}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-ink-faint">
            {loading ? "Reading the session…" : "Nothing here yet — the tree fills in as you talk."}
          </p>
        ) : (
          rows.map(({ node }) => (
            <TreeRow
              key={node.id}
              node={node}
              depth={depths.get(node.id) ?? 0}
              isLive={live.has(node.id)}
              isLeaf={node.id === leafId}
              isFork={forks.has(node.id)}
              isSelected={node.id === selectedNodeId}
              canJump={bridgeReady}
              onJump={() => void jump(node)}
              onLabel={(label) => void labelEntry(node.id, label)}
            />
          ))
        )}
      </div>

      <footer className="shrink-0 border-t border-line px-3 py-2">
        <label className="flex cursor-pointer items-start gap-2 text-sm text-ink-dim">
          <input
            type="checkbox"
            checked={summarize}
            onChange={(e) => setSetting("summarizeOnJump", e.target.checked)}
            className="mt-0.5 accent-amber"
          />
          <span>
            Summarize the branch I leave
            <span className="block text-2xs text-ink-faint">
              Carries context from the abandoned path across. Costs one model call per jump.
            </span>
          </span>
        </label>
      </footer>
    </aside>
  );
}

function TreeRow({
  node,
  depth,
  isLive,
  isLeaf,
  isFork,
  isSelected,
  canJump,
  onJump,
  onLabel,
}: {
  node: TreeNode;
  depth: number;
  isLive: boolean;
  isLeaf: boolean;
  isFork: boolean;
  isSelected: boolean;
  canJump: boolean;
  onJump: () => void;
  onLabel: (label: string) => void;
}) {
  const [labelling, setLabelling] = useState(false);
  const [draft, setDraft] = useState(node.label ?? "");

  const tone = isLive ? "text-ink-text" : "text-ink-faint";
  const marker = isLeaf
    ? "bg-amber"
    : isLive
      ? "bg-amber-dim"
      : node.type === "branch_summary"
        ? "bg-teal"
        : "bg-ink-3";

  return (
    <div
      className={`group relative flex items-start gap-1.5 py-1 pr-3 ${isSelected ? "bg-ink-2" : "hover:bg-ink-2/60"}`}
      style={{ paddingLeft: `${12 + depth * INDENT}px` }}
    >
      {/* Guides for each level this row sits inside, so a fork reads as a fork
          rather than as an indent. */}
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute top-0 bottom-0 w-px bg-line-strong/70"
          style={{ left: `${15 + i * INDENT}px` }}
        />
      ))}
      <span
        aria-hidden
        className={`relative z-10 mt-[7px] h-[7px] w-[7px] shrink-0 rounded-full ring-2 ring-ink-1 ${marker}`}
      />
      <button
        onClick={onJump}
        disabled={!canJump}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
        title={canJump ? "Continue from here" : "Jumping needs the session bridge"}
      >
        <span className="flex items-baseline gap-1.5">
          <span className={`font-mono text-2xs tracking-wide ${isLive ? "text-amber-dim" : "text-ink-faint"}`}>
            {nodeTitle(node)}
          </span>
          {node.label ? (
            <span className="rounded-[3px] bg-teal/15 px-1 font-mono text-2xs text-teal">{node.label}</span>
          ) : null}
          {isFork ? <span className="font-mono text-2xs text-ink-faint">⑂</span> : null}
          {isLeaf ? <span className="font-mono text-2xs text-amber">live</span> : null}
        </span>
        {node.preview ? (
          <span className={`mt-0.5 block truncate text-sm ${tone}`}>{node.preview}</span>
        ) : null}
      </button>

      {labelling ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setLabelling(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onLabel(draft.trim());
              setLabelling(false);
            }
            if (e.key === "Escape") setLabelling(false);
          }}
          placeholder="label"
          className="w-24 rounded-sm border border-line bg-ink-0 px-1 font-mono text-2xs text-ink-text"
        />
      ) : (
        <button
          onClick={() => setLabelling(true)}
          aria-label="Label this point"
          title="Label this point — labels show up in the agent's own /tree too"
          className="row-actions mt-0.5 text-ink-faint hover:text-teal"
        >
          <Bookmark size={11} />
        </button>
      )}
    </div>
  );
}
