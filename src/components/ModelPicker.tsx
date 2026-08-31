import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Folder, Server } from "lucide-react";
import type { ModelInfo } from "../lib/agent-state";
import { useAppStore } from "../lib/agent-store";

/** Closes a popover on an outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

const TRIGGER =
  "flex h-control-sm items-center gap-1 rounded-sm px-2 font-mono text-2xs text-ink-dim hover:bg-ink-2 hover:text-ink-text";

/** The model in play, and the catalog to change it. Sits with the composer,
 *  where the choice is actually made. */
export function ModelChip({ align = "right" }: { align?: "left" | "right" }) {
  const models = useAppStore((s) => s.models);
  const modelsError = useAppStore((s) => s.modelsError);
  const selected = useAppStore((s) => s.selectedModel);
  const selectModel = useAppStore((s) => s.selectModel);
  const loadModels = useAppStore((s) => s.loadModels);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useDismiss(open, () => setOpen(false));

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            (m.name ?? "").toLowerCase().includes(q) ||
            m.provider.toLowerCase().includes(q),
        )
      : models;
    const out: Record<string, ModelInfo[]> = {};
    for (const m of matched) (out[m.provider] ??= []).push(m);
    return out;
  }, [models, query]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className={TRIGGER}>
        <span className="max-w-[150px] truncate text-ink-text">
          {selected ? selected.name || selected.id : "choose a model"}
        </span>
        <ChevronDown size={11} className="text-ink-faint" />
      </button>

      {open ? (
        <div
          className={`absolute bottom-full z-50 mb-1 w-[300px] overflow-hidden rounded-lg border border-line bg-ink-1 shadow-2xl shadow-black/60 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter models"
            className="w-full border-b border-line bg-transparent px-3 py-2 text-base text-ink-text placeholder:text-ink-faint"
          />
          <div className="max-h-[300px] overflow-y-auto p-1">
            {modelsError ? <div className="px-2 py-2 font-mono text-xs text-red">{modelsError}</div> : null}
            {!modelsError && Object.keys(groups).length === 0 ? (
              <div className="px-2 py-4 text-center text-sm text-ink-faint">
                {models.length ? "No model matches that." : "No models configured yet."}
              </div>
            ) : null}
            {Object.entries(groups).map(([provider, list]) => (
              <div key={provider} className="mb-1">
                <div className="px-2 py-1 font-mono text-2xs tracking-wider text-ink-faint uppercase">{provider}</div>
                {list.map((m) => (
                  <button
                    key={`${m.provider}/${m.id}`}
                    onClick={() => {
                      void selectModel(m);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-ink-2 ${
                      selected?.id === m.id && selected?.provider === m.provider ? "bg-ink-2" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-base text-ink-text">{m.name || m.id}</span>
                    {m.contextWindow ? (
                      <span className="font-mono text-2xs text-ink-faint">{Math.round(m.contextWindow / 1000)}k</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <button
            onClick={() => void loadModels()}
            className="w-full border-t border-line py-2 text-center font-mono text-2xs text-ink-faint hover:text-ink-dim"
          >
            reload catalog
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** How hard the model should think. Hidden for models that cannot reason. */
export function ThinkingChip() {
  const selected = useAppStore((s) => s.selectedModel);
  const thinking = useAppStore((s) => s.thinking);
  const setThinking = useAppStore((s) => s.setThinking);
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  const levels = selected?.thinkingLevels?.length ? selected.thinkingLevels : ["off", "low", "medium", "high"];
  if (selected && !selected.reasoning) return null;

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className={TRIGGER} title="Thinking level">
        <span className="text-ink-text capitalize">{thinking}</span>
        <ChevronDown size={11} className="text-ink-faint" />
      </button>
      {open ? (
        <div className="absolute right-0 bottom-full z-50 mb-1 w-[150px] overflow-hidden rounded-lg border border-line bg-ink-1 p-1 shadow-2xl shadow-black/60">
          {levels.map((level) => (
            <button
              key={level}
              onClick={() => {
                void setThinking(level);
                setOpen(false);
              }}
              className={`flex w-full items-center rounded-sm px-2 py-1.5 text-left text-base capitalize ${
                thinking === level ? "bg-ink-2 text-amber" : "text-ink-dim hover:bg-ink-2 hover:text-ink-text"
              }`}
            >
              {level}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Where the agent runs, and in which folder. */
export function TargetChips() {
  const target = useAppStore((s) => s.target);
  const hosts = useAppStore((s) => s.hosts);
  const cwd = useAppStore((s) => s.cwd);
  const setTarget = useAppStore((s) => s.setTarget);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  const chooseFolder = async () => {
    const { open: pick } = await import("@tauri-apps/plugin-dialog");
    const dir = await pick({ directory: true, multiple: false });
    if (typeof dir === "string") openWorkspace({ cwd: dir, target });
  };

  const folder = cwd ? (cwd.split("/").filter(Boolean).pop() ?? cwd) : null;

  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex h-control-sm items-center gap-1.5 rounded-sm border border-line px-2 font-mono text-2xs text-ink-dim hover:border-line-strong hover:text-ink-text"
        >
          <Server size={10} className={target ? "text-teal" : "text-ink-faint"} />
          {target ?? "Local"}
        </button>
        {open ? (
          <div className="absolute bottom-full left-0 z-50 mb-1 w-[180px] overflow-hidden rounded-lg border border-line bg-ink-1 p-1 shadow-2xl shadow-black/60">
            <button
              onClick={() => {
                setTarget(null);
                setOpen(false);
              }}
              className={`w-full rounded-sm px-2 py-1.5 text-left text-base ${
                target === null ? "bg-ink-2 text-ink-text" : "text-ink-dim hover:bg-ink-2"
              }`}
            >
              Local
            </button>
            {hosts.map((h) => (
              <button
                key={h.alias}
                onClick={() => {
                  setTarget(h.alias);
                  setOpen(false);
                }}
                className={`w-full rounded-sm px-2 py-1.5 text-left text-base ${
                  target === h.alias ? "bg-ink-2 text-ink-text" : "text-ink-dim hover:bg-ink-2"
                }`}
              >
                {h.alias}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <button
        onClick={() => void chooseFolder()}
        title={cwd ?? "Choose a folder"}
        className="flex h-control-sm min-w-0 items-center gap-1.5 rounded-sm border border-line px-2 font-mono text-2xs text-ink-dim hover:border-line-strong hover:text-ink-text"
      >
        <Folder size={10} className="shrink-0 text-amber-dim" />
        <span className="truncate">{folder ?? "Select folder…"}</span>
      </button>
    </div>
  );
}

