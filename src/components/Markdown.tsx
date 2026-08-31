import { memo, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlight } from "../lib/highlight";

/**
 * Assistant prose.
 *
 * Headings are styled explicitly: Tailwind's preflight resets h1–h6 to the
 * body's size and weight, so a reply's structure is invisible without this.
 * Paragraphs deliberately do *not* preserve whitespace — a markdown soft break
 * is a space, and forcing it to a line break makes every reply wrap at whatever
 * column the model happened to emit.
 */
function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="selectable space-y-3 text-md text-ink-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-5 mb-1.5 text-xl font-semibold tracking-tight text-ink-text first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-5 mb-1 text-lg font-semibold tracking-tight text-ink-text first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-4 mb-0.5 text-ml font-semibold text-ink-text first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-4 mb-0.5 text-md font-semibold text-ink-text first:mt-0">
              {children}
            </h4>
          ),
          h5: ({ children }) => <h5 className="mt-3 text-md font-medium text-ink-dim">{children}</h5>,
          h6: ({ children }) => <h6 className="mt-3 text-sm font-semibold tracking-wide text-ink-faint uppercase">{children}</h6>,
          p: ({ children }) => <p>{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-ink-text">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          hr: () => <hr className="my-4 border-0 border-t border-line" />,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-teal underline decoration-teal/40 underline-offset-2 hover:decoration-teal"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="ml-5 list-disc space-y-1 marker:text-ink-faint">{children}</ul>,
          ol: ({ children }) => <ol className="ml-5 list-decimal space-y-1 marker:text-ink-faint">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-line pl-3 text-ink-dim">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full border-collapse font-mono text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-line bg-ink-2 px-2.5 py-1.5 text-left font-medium text-ink-text">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border-b border-line/60 px-2.5 py-1.5 align-top">{children}</td>,
          code: ({ className, children, ...props }) => {
            const lang = /language-(\w+)/.exec(className ?? "")?.[1];
            if (!lang && !String(children).includes("\n")) {
              return (
                <code
                  className="rounded-[4px] bg-ink-2 px-1.5 py-0.5 font-mono text-sm text-ink-text"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return <CodeBlock code={String(children).replace(/\n$/, "")} lang={lang} />;
          },
          // react-markdown wraps blocks in <pre>; CodeBlock draws its own frame.
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** A code block with its language, a copy button, and lazy highlighting. */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let live = true;
    void highlight(code, lang ?? "").then((result) => {
      if (live) setHtml(result);
    });
    return () => {
      live = false;
    };
  }, [code, lang]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="group relative overflow-hidden rounded-md border border-line bg-ink-0">
      <div className="flex items-center gap-2 border-b border-line/70 px-3 py-1">
        <span className="font-mono text-2xs tracking-wider text-ink-faint uppercase">{lang || "text"}</span>
        <button
          onClick={() => void copy()}
          className="row-actions ml-auto flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-2xs text-ink-faint hover:bg-ink-2 hover:text-ink-text"
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {html ? (
        <div
          className="[&_pre]:selectable overflow-x-auto px-3 py-2 font-mono text-sm [&_pre]:!bg-transparent"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="selectable overflow-x-auto px-3 py-2 font-mono text-sm text-ink-text">{code}</pre>
      )}
    </div>
  );
}

/** Streaming re-renders this on every delta; only new text should cost work. */
export default memo(MarkdownBody);
