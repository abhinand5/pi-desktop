import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Folder, Server } from "lucide-react";
import { asModelInfo, type ModelInfo } from "../lib/agent-state";
import { useAppStore } from "../lib/agent-store";
import { projectLabel } from "../lib/store/workspace";

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

/**
 * Which way a popover should open.
 *
 * These chips sit with the composer at the bottom of the window, where opening
 * upward is right, and they are reused on the settings page near the top, where
 * it puts the panel off-screen. So ask the viewport rather than the call site:
 * open upward only when there is actually room above.
 */
function usePlacement(open: boolean, ref: React.RefObject<HTMLDivElement | null>, height: number) {
  const [drop, setDrop] = useState(false);
  useEffect(() => {
    if (!open) return;
    const box = ref.current?.getBoundingClientRect();
    if (box) setDrop(box.top < height + 16 && window.innerHeight - box.bottom > box.top);
  }, [open, ref, height]);
  return drop ? "bottom" : "top";
}

/** Positions a popover above or below its trigger. */
function panelSide(place: "top" | "bottom"): string {
  return place === "top" ? "bottom-full mb-1" : "top-full mt-1";
}

const TRIGGER =
  "flex h-control-sm items-center gap-1 rounded-sm px-2 font-mono text-2xs text-ink-dim hover:bg-ink-2 hover:text-ink-text";

/** The model in play, and the catalog to change it. Sits with the composer,
 *  where the choice is actually made. */
export function ModelChip() {
  const selected = useAppStore((s) => s.selectedModel);
  const selectModel = useAppStore((s) => s.selectModel);
  const [open, setOpen] = useState(false);
  return (
    <ModelPopover label={selected ? selected.name || selected.id : "choose a model"} open={open} setOpen={setOpen}>
      <ModelCatalogPanel
        selected={selected}
        onSelect={(m) => {
          void selectModel(m);
          setOpen(false);
        }}
      />
    </ModelPopover>
  );
}

/**
 * The default model for every new session, read from — and written back to —
 * the harness's own config. Lives on the settings page, where the global
 * choice belongs; the composer chip is the per-session override.
 */
export function DefaultModelChip() {
  const harnessDefault = useAppStore((s) => s.harnessDefault);
  const setDefaultModel = useAppStore((s) => s.setDefaultModel);
  const [open, setOpen] = useState(false);
  return (
    <ModelPopover
      label={harnessDefault ? modelLabel(harnessDefault.id, harnessDefault.thinking) : "not set"}
      title={harnessDefault ? `${harnessDefault.provider}/${harnessDefault.id}` : undefined}
      open={open}
      setOpen={setOpen}
    >
      <ModelCatalogPanel
        selected={asModelInfo(harnessDefault)}
        onSelect={(m) => {
          void setDefaultModel({ provider: m.provider, id: m.id });
          setOpen(false);
        }}
        clear={
          harnessDefault
            ? () => {
                void setDefaultModel(null);
                setOpen(false);
              }
            : undefined
        }
      />
    </ModelPopover>
  );
}

/** Chip label for a model id, with the configured thinking level if known. */
function modelLabel(id: string, thinking?: string | null): string {
  return thinking ? `${id} · ${thinking}` : id;
}

/** Trigger plus placement for a catalog popover. */
function ModelPopover({
  label,
  title,
  open,
  setOpen,
  children,
}: {
  label: string;
  title?: string;
  open: boolean;
  setOpen: (v: boolean) => void;
  children: React.ReactNode;
}) {
  const ref = useDismiss(open, () => setOpen(false));
  const place = usePlacement(open, ref, 380);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className={TRIGGER} title={title}>
        <span className="max-w-[150px] truncate text-ink-text">{label}</span>
        <ChevronDown size={11} className="text-ink-faint" />
      </button>
      {open ? (
        <div
          className={`overlay absolute right-0 z-50 w-[300px] overflow-hidden rounded-lg border border-line bg-ink-1 ${panelSide(place)}`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The model catalog: filter, grouped by provider, reload. `clear` offers
 * removing the selection — the default chip uses it to unset the harness's
 * own default.
 */
function ModelCatalogPanel({
  selected,
  onSelect,
  clear,
}: {
  selected: ModelInfo | null;
  onSelect: (m: ModelInfo) => void;
  clear?: () => void;
}) {
  const models = useAppStore((s) => s.models);
  const modelsError = useAppStore((s) => s.modelsError);
  const loadModels = useAppStore((s) => s.loadModels);
  const [query, setQuery] = useState("");

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
    <>
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
            <div className="eyebrow px-2 py-1 font-mono text-2xs tracking-wider text-ink-faint uppercase">{provider}</div>
            {list.map((m) => (
              <button
                key={`${m.provider}/${m.id}`}
                onClick={() => onSelect(m)}
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
      {clear ? (
        <button
          onClick={clear}
          className="w-full border-t border-line py-2 text-center font-mono text-2xs text-ink-faint hover:text-ink-dim"
        >
          clear default
        </button>
      ) : null}
      <button
        onClick={() => void loadModels()}
        className="w-full border-t border-line py-2 text-center font-mono text-2xs text-ink-faint hover:text-ink-dim"
      >
        reload catalog
      </button>
    </>
  );
}

/** How hard the model should think. Hidden for models that cannot reason. */
export function ThinkingChip() {
  const selected = useAppStore((s) => s.selectedModel);
  const thinking = useAppStore((s) => s.thinking);
  const setThinking = useAppStore((s) => s.setThinking);
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const place = usePlacement(open, ref, 200);

  const levels = selected?.thinkingLevels?.length ? selected.thinkingLevels : ["off", "low", "medium", "high"];
  if (selected && !selected.reasoning) return null;

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className={TRIGGER} title="Thinking level">
        <span className="text-ink-text capitalize">{thinking}</span>
        <ChevronDown size={11} className="text-ink-faint" />
      </button>
      {open ? (
        <div className={`absolute right-0 z-50 w-[150px] overflow-hidden rounded-lg border border-line bg-ink-1 p-1 overlay ${panelSide(place)}`}>
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

/**
 * Where this session runs, and in which folder.
 *
 * Both are stated, neither is a control. A session's machine is settled when it
 * is opened: it has a process on that box, a session file on that disk, and a
 * working directory that means nothing anywhere else. This used to be a picker
 * that re-pointed the session in place — which killed the runtime and left the
 * workspace claiming to be in a directory the new machine had never heard of.
 * Machines are switched in the rail, where switching means going to that
 * machine's own work rather than dragging this session onto it.
 */
export function TargetChips() {
  const target = useAppStore((s) => s.target);
  const cwd = useAppStore((s) => s.cwd);
  const setPanel = useAppStore((s) => s.setPanel);
  const openWorkspace = useAppStore((s) => s.openWorkspace);

  const chooseFolder = async () => {
    // A remote folder cannot come from the OS picker, which only sees this
    // machine's disk.
    if (target) {
      setPanel("files");
      return;
    }
    const { open: pick } = await import("@tauri-apps/plugin-dialog");
    const dir = await pick({ directory: true, multiple: false });
    if (typeof dir === "string") openWorkspace({ cwd: dir, target: null });
  };

  const folder = cwd ? projectLabel(cwd) : null;

  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <span
        title={target ? `This session runs on ${target}` : "This session runs on this machine"}
        className="flex h-control-sm items-center gap-1.5 rounded-sm border border-line px-2 font-mono text-2xs text-ink-dim"
      >
        <Server size={10} className={target ? "text-teal" : "text-ink-faint"} />
        {target ?? "Local"}
      </span>

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

