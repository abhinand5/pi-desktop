/**
 * Code highlighting for the transcript.
 *
 * Built on shiki's core with an explicit grammar list rather than the full
 * bundle, which ships a chunk for every language shiki knows — Wolfram and
 * Emacs Lisp included. Only the languages an agent actually emits are wired up.
 *
 * Highlighting is best-effort and asynchronous: a block renders as plain
 * monospace immediately and upgrades in place once its grammar loads. Code is
 * never withheld waiting for a highlighter.
 */

import type { HighlighterCore } from "shiki/core";

/** Grammar loaders, imported lazily so a session that shows no Rust pays
 *  nothing for the Rust grammar. */
const LANGS = {
  typescript: () => import("@shikijs/langs/typescript"),
  javascript: () => import("@shikijs/langs/javascript"),
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  rust: () => import("@shikijs/langs/rust"),
  python: () => import("@shikijs/langs/python"),
  bash: () => import("@shikijs/langs/bash"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  sql: () => import("@shikijs/langs/sql"),
  go: () => import("@shikijs/langs/go"),
  markdown: () => import("@shikijs/langs/markdown"),
  diff: () => import("@shikijs/langs/diff"),
} as const;

type Lang = keyof typeof LANGS;

const ALIASES: Record<string, Lang> = {
  ts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", sh: "bash", zsh: "bash", fish: "bash",
  shell: "bash", console: "bash", yml: "yaml", md: "markdown", patch: "diff",
};

let corePromise: Promise<HighlighterCore> | null = null;
const loaded = new Set<Lang>();

async function core(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }, theme] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/oniguruma"),
        import("@shikijs/themes/vitesse-dark"),
      ]);
      return createHighlighterCore({
        themes: [theme.default],
        langs: [],
        engine: createOnigurumaEngine(import("shiki/wasm")),
      });
    })();
  }
  return corePromise;
}

export function normalizeLang(raw: string | undefined): Lang | null {
  if (!raw) return null;
  const lang = raw.toLowerCase();
  const mapped = (ALIASES[lang] ?? lang) as Lang;
  return mapped in LANGS ? mapped : null;
}

/** Highlighted HTML, or null when the language is unknown or unavailable —
 *  callers fall back to plain text. */
export async function highlight(code: string, rawLang: string): Promise<string | null> {
  const lang = normalizeLang(rawLang);
  if (!lang) return null;
  try {
    const highlighter = await core();
    if (!loaded.has(lang)) {
      await highlighter.loadLanguage(await LANGS[lang]());
      loaded.add(lang);
    }
    return highlighter.codeToHtml(code, {
      lang,
      theme: "vitesse-dark",
      // The page owns the surface colour; the theme only colours the tokens.
      colorReplacements: { "#121212": "transparent" },
    });
  } catch {
    return null;
  }
}
