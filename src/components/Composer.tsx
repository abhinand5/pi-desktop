import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { bridge, type FsEntry, type ImageAttachment } from "../lib/bridge";
import { useAppStore } from "../lib/agent-store";
import {
  builtinCommands,
  createRegistry,
  harnessCommands,
  parseSlashInvocation,
  type Command,
  type CommandContext,
} from "../lib/commands";
import { nearestUserEntry } from "../lib/tree";
import ApprovalDialog from "./ApprovalDialog";
import ComposerStatusBar from "./ComposerStatusBar";
import { columnWidth } from "../lib/layout";
import { ModelChip, TargetChips, ThinkingChip } from "./ModelPicker";

const MAX_HISTORY = 50;

interface Attachment extends ImageAttachment {
  id: string;
  name: string;
  size: number;
  previewUrl: string;
}
/** Clipboard images can arrive as items without appearing in `files`. */
function clipboardFiles(data: DataTransfer): File[] {
  const files = [...data.files];
  if (files.length) return files;
  return [...data.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** Reads an image through the native clipboard path used by Tauri webviews. */
async function nativeClipboardImage(): Promise<File | null> {
  const image = await bridge.clipboardImage();
  if (!image) return null;

  const binary = atob(image.data);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const extension = image.mimeType.split("/")[1]?.replace(/[^a-z0-9]+/gi, "") || "bin";
  return new File([bytes], `pasted-image.${extension}`, { type: image.mimeType });
}

async function fallbackClipboardImages(allowAsyncFallback: boolean): Promise<File[]> {
  try {
    const image = await nativeClipboardImage();
    return image ? [image] : [];
  } catch {
    // Browser preview and older native builds can lack the native command.
    return allowAsyncFallback ? asyncClipboardImages() : [];
  }
}

/** WebKitGTK can hide image data from the paste event; async clipboard exposes it. */
async function asyncClipboardImages(): Promise<File[]> {
  if (!navigator.clipboard?.read) return [];
  const items = await navigator.clipboard.read();
  const files: File[] = [];
  for (const [index, item] of items.entries()) {
    const type = item.types.find((candidate) => candidate.startsWith("image/"));
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      const extension = type.split("/")[1]?.replace(/[^a-z0-9]+/gi, "") || "bin";
      files.push(new File([blob], `pasted-image-${index + 1}.${extension}`, { type: blob.type || type }));
    } catch {
      // One unavailable representation should not block other clipboard items.
    }
  }
  return files;
}

/**
 * The composer.
 *
 * Idle, Enter sends. While the agent runs, Enter queues a steer — delivered
 * after the current tool round — and follow-up waits for the turn to settle;
 * the two are separate modes because they mean genuinely different things.
 */
export default function Composer() {
  const runtime = useAppStore((s) => s.runtime);
  const wide = useAppStore((s) => s.settings.transcriptWidth === "wide");
  const streaming = useAppStore((s) => s.agent.streaming);
  const queue = useAppStore((s) => s.agent.queue);
  const connectionError = useAppStore((s) => s.connectionError);
  const connecting = useAppStore((s) => s.connecting);
  const notice = useAppStore((s) => s.notice);
  const setNotice = useAppStore((s) => s.setNotice);
  const composerDraft = useAppStore((s) => s.composerDraft);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const harnessCmds = useAppStore((s) => s.harnessCommands);
  const bridgeReady = useAppStore((s) => s.bridgeReady);
  const tree = useAppStore((s) => s.tree);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [followUpMode, setFollowUpMode] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const [mentions, setMentions] = useState<FsEntry[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = runtime !== null && !runtime.exited;

  // A tree jump hands the original prompt back for editing.
  useEffect(() => {
    if (composerDraft === null) return;
    setText(composerDraft);
    setComposerDraft(null);
    ref.current?.focus();
  }, [composerDraft, setComposerDraft]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const store = useAppStore;
  const registry = useMemo(() => {
    const s = store.getState();
    return createRegistry([
      builtinCommands({
        compact: (instructions) => void s.compact(instructions),
        newSession: () => void s.newSession(),
        rename: (name) => void s.renameSession(name),
        export: () => {
          void s.exportSession().then((path) => setNotice(path ? `Exported to ${path}` : null));
        },
        openTree: () => s.setPanel("tree"),
        openStatus: () => s.setPanel("status"),
        openTerminal: () => s.setPanel("terminal"),
        openProviders: () => s.setPanel("providers"),
        retryLast: () => {
          const target = nearestUserEntry(store.getState().tree?.nodes ?? [], store.getState().leafId);
          if (target) void store.getState().retryEntry(target.id);
          else setError("There is no prompt to retry yet.");
        },
        copyLast: () => {
          const last = [...store.getState().agent.entries]
            .reverse()
            .find((e) => e.kind === "assistant");
          const body =
            last?.kind === "assistant"
              ? last.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n\n")
              : "";
          if (body) void navigator.clipboard.writeText(body);
        },
        fork: () => {
          const target = nearestUserEntry(store.getState().tree?.nodes ?? [], store.getState().leafId);
          if (target) void store.getState().forkFrom(target.id);
        },
        clone: () => void s.cloneSession(),
        abort: () => void s.abort(),
      }),
      harnessCommands(harnessCmds),
    ]);
  }, [store, harnessCmds, setNotice]);

  const ctx: CommandContext = useMemo(
    () => ({
      active,
      streaming,
      hasSession: active,
      hasTree: (tree?.nodes.length ?? 0) > 0,
      bridgeReady,
    }),
    [active, streaming, tree, bridgeReady],
  );

  // The menu opens on a slash at the start of the line and closes once the
  // command name is settled and arguments are being typed.
  const invocation = text.startsWith("/") ? parseSlashInvocation(text) : null;
  const menuOpen = text.startsWith("/") && !text.includes("\n") && (invocation === null || !text.includes(" "));
  const matches = useMemo(
    () => (menuOpen ? registry.match(invocation?.name ?? "", ctx, 14) : []),
    [menuOpen, registry, invocation?.name, ctx],
  );
  useEffect(() => setMenuIndex(0), [text]);

  const cwd = useAppStore((s) => s.cwd);
  const target = useAppStore((s) => s.target);
  const mentionQuery = useMemo(() => {
    const match = /(?:^|\s)@([^\s]*)$/.exec(text);
    return match ? match[1] : null;
  }, [text]);

  useEffect(() => {
    if (mentionQuery === null || !cwd) {
      setMentions([]);
      return;
    }
    let live = true;
    const slash = mentionQuery.lastIndexOf("/");
    const dir = slash === -1 ? cwd : `${cwd}/${mentionQuery.slice(0, slash)}`;
    const leaf = (slash === -1 ? mentionQuery : mentionQuery.slice(slash + 1)).toLowerCase();
    const list = target ? bridge.sshFsList(target, null, dir) : bridge.fsList(dir);
    void list
      .then((entries) => {
        if (!live) return;
        setMentions(entries.filter((e) => e.name.toLowerCase().includes(leaf)).slice(0, 8));
        setMentionIndex(0);
      })
      .catch(() => live && setMentions([]));
    return () => {
      live = false;
    };
  }, [mentionQuery, cwd, target]);

  const pickMention = (entry: FsEntry) => {
    // Directories keep the picker open so the next segment can be chosen.
    const relative = cwd && entry.path.startsWith(cwd) ? entry.path.slice(cwd.length + 1) : entry.path;
    setText((current) => current.replace(/@[^\s]*$/, `@${relative}${entry.isDir ? "/" : " "}`));
    ref.current?.focus();
  };

  const addFiles = useCallback(async (files: FileList | File[] | null) => {
    if (!files) return;
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (images.length !== [...files].length) {
      setError("Only images can be attached — the harness takes images alongside a prompt.");
    }
    const read = await Promise.all(
      images.map(
        (file) =>
          new Promise<Attachment>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error);
            reader.onload = () => {
              const url = String(reader.result);
              resolve({
                id: `${file.name}-${file.size}-${url.length}`,
                type: "image",
                // The harness wants raw base64, not a data: URL.
                data: url.slice(url.indexOf(",") + 1),
                mimeType: file.type,
                name: file.name || "pasted-image",
                size: file.size,
                previewUrl: url,
              });
            };
            reader.readAsDataURL(file);
          }),
      ),
    );
    setAttachments((current) => [...current, ...read]);
  }, []);

  const pickCommand = async (command: Command) => {
    setError(null);
    const args = invocation?.args ?? "";
    const outcome = await command.run(args, ctx);
    switch (outcome.kind) {
      case "handled":
        setText("");
        break;
      case "set-input":
        setText(outcome.input);
        break;
      case "error":
        setError(outcome.message);
        break;
      case "passthrough":
        // The harness owns its own namespace; hand the line over untouched.
        void deliver(`/${command.name}${args ? ` ${args}` : ""}`);
        setText("");
        break;
    }
    ref.current?.focus();
  };

  const deliver = async (body: string) => {
    const s = store.getState();
    if (!streaming) await s.sendPrompt(body, attachments.map(({ type, data, mimeType }) => ({ type, data, mimeType })));
    else if (followUpMode) await s.followUp(body);
    else await s.steer(body);
    setAttachments([]);
    setFollowUpMode(false);
  };

  const submit = async () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || !active) return;
    setError(null);
    setHistory((h) => [trimmed, ...h.filter((x) => x !== trimmed)].slice(0, MAX_HISTORY));
    setHistoryAt(null);

    const parsed = parseSlashInvocation(trimmed);
    if (parsed) {
      const command = registry.find(parsed.name, ctx);
      if (command) {
        await pickCommand(command);
        return;
      }
      // Unknown to us is not unknown to the agent — it owns extensions,
      // templates, and skills, so pass the line straight through.
    }
    setText("");
    await deliver(trimmed);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentions.length) % mentions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickMention(mentions[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentions([]);
        return;
      }
    }

    if (menuOpen && matches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        void pickCommand(matches[menuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
    }

    // Prompt history, only from an untouched or history-driven field, so it
    // never eats a cursor movement inside something being written.
    if (e.key === "ArrowUp" && !e.shiftKey && history.length && (text === "" || historyAt !== null)) {
      const next = historyAt === null ? 0 : Math.min(historyAt + 1, history.length - 1);
      e.preventDefault();
      setHistoryAt(next);
      setText(history[next]);
      return;
    }
    if (e.key === "ArrowDown" && historyAt !== null) {
      e.preventDefault();
      const next = historyAt - 1;
      setHistoryAt(next < 0 ? null : next);
      setText(next < 0 ? "" : history[next]);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className={`mx-auto w-full px-6 pb-5 ${columnWidth(wide)}`}>
      <ApprovalDialog />

      {queue.steering.length + queue.followUp.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {queue.steering.map((q, i) => (
            <QueueChip key={`s${i}`} label={q} tag="steer" />
          ))}
          {queue.followUp.map((q, i) => (
            <QueueChip key={`f${i}`} label={q} tag="follow-up" />
          ))}
        </div>
      ) : null}

      {notice ? (
        <Banner tone="info" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}
      {connectionError ? <Banner tone="error">{connectionError}</Banner> : null}

      <TargetChips />

      {menuOpen ? <CommandMenu matches={matches} index={menuIndex} onPick={pickCommand} /> : null}
      {mentions.length ? (
        <div className="mb-1 max-h-[220px] overflow-y-auto rounded-md border border-line bg-ink-1">
          {mentions.map((entry, i) => (
            <button
              key={entry.path}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(entry);
              }}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${i === mentionIndex ? "bg-ink-2" : ""}`}
            >
              <span className={`font-mono text-sm ${entry.isDir ? "text-amber-dim" : "text-ink-text"}`}>
                {entry.name}
                {entry.isDir ? "/" : ""}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {attachments.length ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="flex items-center gap-1.5 rounded-sm border border-line bg-ink-2 py-0.5 pr-1 pl-1.5"
            >
              <img src={a.previewUrl} alt="" className="h-5 w-5 rounded-[3px] object-cover" />
              <span className="max-w-[160px] truncate font-mono text-2xs text-ink-dim">{a.name}</span>
              <button
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                aria-label={`Remove ${a.name}`}
                className="text-ink-faint hover:text-red"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
        className="chrome rounded-lg border border-line bg-ink-1 px-3 py-2.5 focus-within:border-amber-dim/60"
      >
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = clipboardFiles(e.clipboardData);
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
              return;
            }

            // GTK/WebKit may report no DataTransfer files or items for an
            // image. Keep ordinary text paste native, and probe the native
            // clipboard first. The async browser API is only a compatibility
            // fallback when the native command is unavailable.
            const types = [...e.clipboardData.types];
            const allowAsyncFallback = !types.length || types.some((type) => type.startsWith("image/"));
            void fallbackClipboardImages(allowAsyncFallback)
              .then((images) => {
                if (images.length) void addFiles(images);
              })
              .catch(() => {});
          }}
          onKeyDown={onKeyDown}
          placeholder={
            connecting
              ? "Starting the agent…"
              : !active
              ? "Start a session to begin"
              : streaming
                ? followUpMode
                  ? "Runs once the agent settles"
                  : "Steer the agent mid-run"
                : "Describe the task, or press / for commands"
          }
          className="w-full resize-none bg-transparent text-md text-ink-text placeholder:text-ink-faint"
        />

        <div className="mt-1.5 flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => void addFiles(e.currentTarget.files)}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={!active}
            aria-label="Attach an image"
            title="Attach an image — or paste and drop into the composer"
            className="flex h-control-sm w-control-sm items-center justify-center rounded-sm text-ink-faint hover:bg-ink-2 hover:text-ink-text disabled:opacity-30"
          >
            <Paperclip size={13} />
          </button>

          {streaming ? (
            <>
              <ModeChip active={!followUpMode} onClick={() => setFollowUpMode(false)} label="steer" />
              <ModeChip active={followUpMode} onClick={() => setFollowUpMode(true)} label="follow-up" />
            </>
          ) : null}

          <div className="ml-auto flex items-center gap-0.5">
            <ModelChip />
            <ThinkingChip />
            {streaming ? (
              <button
                onClick={() => void useAppStore.getState().abort()}
                className="ml-1 flex h-control items-center gap-1.5 rounded-sm border border-red/40 px-2.5 font-mono text-xs text-red hover:bg-red/10"
              >
                <Square size={9} strokeWidth={2.5} fill="currentColor" /> stop
              </button>
            ) : (
              <button
                onClick={() => void submit()}
                disabled={(!text.trim() && !attachments.length) || !active}
                className="ml-1 flex h-control w-control items-center justify-center rounded-sm bg-amber text-on-accent hover:brightness-110 disabled:opacity-25"
                aria-label="Send"
              >
                <ArrowUp size={14} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>

      <ComposerStatusBar />
    </div>
  );
}

function CommandMenu({
  matches,
  index,
  onPick,
}: {
  matches: Command[];
  index: number;
  onPick: (c: Command) => void;
}) {
  if (!matches.length) {
    return (
      <div className="mb-1 rounded-md border border-line bg-ink-1 px-3 py-2 text-sm text-ink-faint">
        No command by that name. Press Enter to send it to the agent anyway.
      </div>
    );
  }
  return (
    <div className="mb-1 max-h-[300px] overflow-y-auto overflow-x-hidden rounded-md border border-line bg-ink-1">
      {matches.map((c, i) => (
        <button
          key={c.id}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
          className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${
            i === index ? "bg-ink-2" : ""
          }`}
        >
          <span className="font-mono text-sm text-ink-text">/{c.name}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-ink-dim">{c.description}</span>
          <SourceBadge source={c.source} />
        </button>
      ))}
    </div>
  );
}

function SourceBadge({ source }: { source: Command["source"] }) {
  if (source === "desktop") return null;
  return (
    <span className="shrink-0 rounded-[3px] border border-line px-1 font-mono text-2xs text-ink-faint">
      {source}
    </span>
  );
}

function ModeChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-0.5 font-mono text-2xs tracking-wide uppercase ${
        active ? "border-amber-dim bg-amber/10 text-amber" : "border-line text-ink-faint hover:text-ink-dim"
      }`}
    >
      {label}
    </button>
  );
}

function QueueChip({ label, tag }: { label: string; tag: string }) {
  return (
    <span
      title={label}
      className="max-w-[320px] truncate rounded-full border border-line bg-ink-2 px-2.5 py-0.5 font-mono text-2xs text-ink-dim"
    >
      <span className="text-amber-dim">{tag}</span> {label}
    </span>
  );
}

function Banner({
  tone,
  children,
  onDismiss,
}: {
  tone: "info" | "error";
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const styles =
    tone === "error" ? "border-red/30 bg-red/8 text-red" : "border-line bg-ink-2 text-ink-dim";
  return (
    <div className={`mb-2 flex items-start gap-2 rounded-md border px-3 py-1.5 text-sm ${styles}`}>
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss ? (
        <button onClick={onDismiss} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100">
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}
