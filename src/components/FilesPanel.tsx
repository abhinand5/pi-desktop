import { useCallback, useEffect, useState } from "react";
import { ChevronRight, File as FileIcon, Folder, RefreshCw, X } from "lucide-react";
import { bridge } from "../lib/bridge";
import type { FsEntry } from "../lib/bridge";
import { useAppStore } from "../lib/agent-store";

/**
 * Remote file browser over the multiplexed ssh connection: `ls -Apl` for
 * listings, `cat` (512 KB cap) for text preview. Dirs navigate, files open.
 */
export default function FilesPanel() {
  const open = useAppStore((s) => s.openPanel === "files");
  const target = useAppStore((s) => s.target);
  const setPanel = useAppStore((s) => s.setPanel);
  const setOpen = (next: boolean) => setPanel(next ? "files" : null);

  const [cwd, setCwd] = useState("~");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);

  const host = target;

  const load = useCallback(
    async (path: string) => {
      if (!host) return;
      setLoading(true);
      setError(null);
      try {
        const list = await bridge.sshFsList(host, null, path);
        setEntries(list.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)));
        setCwd(path);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [host],
  );

  useEffect(() => {
    if (open && host && cwd === "~") void load("~");
  }, [open, host, cwd, load]);

  if (!open) return null;

  const crumbs = cwd.split("/").filter(Boolean);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={() => setOpen(false)}>
      <div
        className="flex h-full w-[460px] flex-col border-l border-line bg-ink-1"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="flex-1 truncate font-mono text-[11px] text-ink-dim">
            {host}: {cwd}
          </span>
          <button onClick={() => void load(cwd)} className="text-ink-faint hover:text-ink-text" aria-label="Refresh">
            <RefreshCw size={13} />
          </button>
          <button onClick={() => setOpen(false)} className="text-ink-faint hover:text-ink-text" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {crumbs.length > 0 ? (
          <div className="flex items-center gap-0.5 border-b border-line px-3 py-1.5 font-mono text-[10.5px]">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-0.5">
                {i > 0 ? <ChevronRight size={9} className="text-ink-faint" /> : null}
                <button
                  onClick={() => load(crumbs.slice(0, i + 1).join("/") || "/")}
                  className={i === crumbs.length - 1 ? "text-amber" : "text-ink-faint hover:text-ink-dim"}
                >
                  {c}
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error ? <div className="px-2 py-3 font-mono text-[11px] text-red">{error}</div> : null}
          {!error && entries.length === 0 && !loading ? (
            <p className="px-2 pt-3 text-[12px] text-ink-faint">Empty directory.</p>
          ) : null}
          {loading ? <div className="px-2 py-3 font-mono text-[11px] text-ink-faint">loading…</div> : null}
          {entries.map((e) => (
            <button
              key={e.path}
              onClick={() => (e.isDir ? void load(e.path) : void openFile(e.path))}
              className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left hover:bg-ink-2"
            >
              {e.isDir ? (
                <Folder size={13} className="shrink-0 text-amber-dim" />
              ) : (
                <FileIcon size={13} className="shrink-0 text-ink-faint" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-text">{e.name}</span>
              {e.isDir ? <ChevronRight size={11} className="text-ink-faint" /> : null}
            </button>
          ))}
        </div>

        {preview ? (
          <div className="flex h-1/2 flex-col border-t border-line">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-dim">{preview.path}</span>
              <button onClick={() => setPreview(null)} className="text-ink-faint hover:text-ink-text" aria-label="Close preview">
                <X size={14} />
              </button>
            </div>
            <pre className="selectable min-h-0 flex-1 overflow-auto bg-ink-0 p-3 font-mono text-[11px] leading-snug whitespace-pre-wrap text-ink-dim">
              {preview.text}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );

  async function openFile(path: string) {
    setError(null);
    try {
      const text = await bridge.sshFsRead(host!, null, path);
      setPreview({ path, text });
    } catch (e) {
      setError(String(e));
    }
  }
}
