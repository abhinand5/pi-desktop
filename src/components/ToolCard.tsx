import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Entry } from "../lib/agent-state";

type ToolEntry = Extract<Entry, { kind: "tool" }>;

const GLYPHS: Record<string, string> = {
  bash: "$",
  read: "›",
  write: "+",
  edit: "~",
  glob: "*",
  grep: "/",
  list: "·",
};

/** A tool call: what it is doing, and what it produced. */
export default function ToolCard({ tool }: { tool: ToolEntry }) {
  const [expanded, setExpanded] = useState(false);
  const glyph = GLYPHS[tool.name.toLowerCase()] ?? "·";
  const running = tool.status === "running";
  const lines = tool.output ? tool.output.split("\n").length : 0;
  // 12 lines is about a screenful in this column; more than that needs asking.
  const long = lines > 12;

  return (
    <div className="overflow-hidden rounded-md border border-line bg-ink-1 text-sm">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span
          className={`font-mono ${running ? "text-teal" : tool.status === "error" ? "text-red" : "text-ink-dim"}`}
        >
          {glyph}
        </span>
        <span className="shrink-0 font-mono text-xs text-ink-text">{tool.name}</span>
        <ToolArgs args={tool.args} />
        <span className="ml-auto shrink-0 font-mono text-2xs tracking-wider uppercase">
          {running ? (
            <span className="text-teal">running</span>
          ) : tool.status === "error" ? (
            <span className="text-red">failed</span>
          ) : (
            <span className="text-ink-faint">done</span>
          )}
        </span>
      </div>

      {tool.output ? (
        <>
          <pre
            className={`selectable overflow-auto border-t border-line px-3 py-2 font-mono text-sm whitespace-pre-wrap text-ink-dim ${
              long && !expanded ? "max-h-44" : "max-h-[600px]"
            }`}
          >
            {tool.output}
          </pre>
          {long ? (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-center gap-1 border-t border-line py-1 font-mono text-2xs text-ink-faint hover:bg-ink-2 hover:text-ink-dim"
            >
              {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              {expanded ? "collapse" : `show all ${lines} lines`}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ToolArgs({ args }: { args: unknown }) {
  const text = firstArgText(args);
  if (!text) return null;
  return (
    <span className="selectable min-w-0 truncate font-mono text-xs text-ink-dim" title={text}>
      {text}
    </span>
  );
}

/** The one argument that says what this call is about. */
function firstArgText(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "filePath", "query", "pattern", "url"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  return "";
}
