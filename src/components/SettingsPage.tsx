import { RotateCcw } from "lucide-react";
import { useAppStore } from "../lib/agent-store";
import { THEMES, type Settings, type ThinkingDisplay, type ThinkingPace } from "../lib/store/types";
import { ModelChip, ThinkingChip } from "./ModelPicker";

/**
 * Preferences for the application and the active workspace.
 *
 * The model and thinking pickers appear alongside the composer too. Session
 * facts live in the status panel, which keeps this page focused on choices.
 */

export default function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);
  const resetSettings = useAppStore((s) => s.resetSettings);
  const harness = useAppStore((s) => s.harness);
  const setHarness = useAppStore((s) => s.setHarness);
  const providers = useAppStore((s) => s.providers);
  const setPanel = useAppStore((s) => s.setPanel);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-8 py-8">
        <header className="mb-6 flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-ink-text">Settings</h1>
          <button
            onClick={resetSettings}
            className="ml-auto flex items-center gap-1.5 font-mono text-2xs text-ink-faint hover:text-ink-dim"
          >
            <RotateCcw size={10} /> reset to defaults
          </button>
        </header>

        <Group title="Agent and model" hint="Applies to the workspace you are in.">
          <Row label="Model" help="Switching mid-session keeps the conversation.">
            {/* Right-aligned so the panel opens back into the card. The chip
                sits at the card's right edge, and a left-aligned panel would
                run off it. */}
            <ModelChip />
          </Row>
          <Row label="Thinking level" help="How much reasoning the model does before answering.">
            <ThinkingChip />
          </Row>
          <Row label="Agent" help="pi and omp keep separate credentials, models, and sessions.">
            <Segmented
              value={harness}
              options={[
                { value: "pi", label: "pi" },
                { value: "omp", label: "omp" },
              ]}
              onChange={(v) => setHarness(v as "pi" | "omp")}
            />
          </Row>
          <Row label="Endpoints" help={`${providers.length} configured`}>
            <button
              onClick={() => setPanel("providers")}
              className="h-control-sm rounded-sm border border-line px-2.5 font-mono text-2xs text-ink-dim hover:border-line-strong hover:text-ink-text"
            >
              manage
            </button>
          </Row>
        </Group>

        <Group title="Workspaces">
          <Row
            label="Scratch workspace"
            help="Leave empty for Pi Desktop's app-owned default. Use an absolute path or a path starting with ~."
          >
            <input
              value={settings.scratchWorkspacePath}
              onChange={(e) => setSetting("scratchWorkspacePath", e.target.value)}
              placeholder="App data/scratch-workspaces"
              spellCheck={false}
              aria-label="Scratch workspace"
              className="h-control-sm w-[280px] rounded-sm border border-line bg-ink-2 px-2 font-mono text-2xs text-ink-text placeholder:text-ink-faint focus:border-line-strong"
            />
          </Row>
        </Group>

        <Group title="Appearance">
          <div className="px-4 py-3">
            <div className="text-md text-ink-text">Theme</div>
            <div className="mt-0.5 mb-2.5 text-sm text-ink-faint">
              Each palette keeps the same one-accent rule — only the colour changes.
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSetting("theme", t.id)}
                  aria-pressed={settings.theme === t.id}
                  className={`flex items-center gap-2 rounded-sm border px-2 py-1.5 text-left ${
                    settings.theme === t.id
                      ? "border-amber-dim/60 bg-amber/10"
                      : "border-line hover:border-line-strong"
                  }`}
                >
                  {/* Painted in its own palette: the swatch carries the theme
                      attribute, so these are the real colours rather than a
                      second copy of them kept in TypeScript. */}
                  <span
                    data-theme={t.id}
                    aria-hidden
                    className="flex h-6 w-6 shrink-0 flex-col overflow-hidden rounded-[4px] border border-line"
                  >
                    <span className="flex-1 bg-ink-0" />
                    <span className="flex-1 bg-ink-2" />
                    <span className="h-[6px] bg-amber" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink-text">{t.label}</span>
                    <span className="block truncate font-mono text-2xs text-ink-faint">{t.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <Row
            label="Terminal font"
            help="Leave empty for the built-in stack, which prefers a Nerd Font Mono so a TUI's glyphs land in one cell."
          >
            <input
              value={settings.terminalFont}
              onChange={(e) => setSetting("terminalFont", e.target.value)}
              placeholder="JetBrainsMono Nerd Font Mono"
              spellCheck={false}
              aria-label="Terminal font"
              className="h-control-sm w-[220px] rounded-sm border border-line bg-ink-2 px-2 font-mono text-2xs text-ink-text placeholder:text-ink-faint focus:border-line-strong"
            />
          </Row>
          <Toggle
            label="Frosted chrome"
            help="Blurs the sidebar, titlebar, and floating panels. The transcript stays opaque so text never competes with what is behind it."
            checked={settings.glass}
            onChange={(v) => setSetting("glass", v)}
          />
        </Group>

        <Group title="Reading" hint="How the transcript behaves while a turn runs.">
          <Row
            label="Thinking"
            help="Inline shows the reasoning as one live line you can open; collapsed keeps it behind a disclosure."
          >
            <Segmented
              value={settings.thinkingDisplay}
              options={[
                { value: "inline", label: "Inline" },
                { value: "collapsed", label: "Collapsed" },
                { value: "hidden", label: "Hidden" },
              ]}
              onChange={(v) => setSetting("thinkingDisplay", v as ThinkingDisplay)}
            />
          </Row>
          <Row
            label="Thinking pace"
            help="How smoothly the inline line glides. It never changes model generation speed, and it always catches up to the live tail."
          >
            <Segmented
              value={settings.thinkingPace}
              options={[
                { value: "instant", label: "Instant" },
                { value: "readable", label: "Readable" },
                { value: "slow", label: "Slow" },
              ]}
              onChange={(v) => setSetting("thinkingPace", v as ThinkingPace)}
            />
          </Row>
          <Row label="Reading width" help="How wide the transcript column runs.">
            <Segmented
              value={settings.transcriptWidth}
              options={[
                { value: "narrow", label: "Narrow" },
                { value: "wide", label: "Wide" },
              ]}
              onChange={(v) => setSetting("transcriptWidth", v as Settings["transcriptWidth"])}
            />
          </Row>
          <Toggle
            label="Show speed"
            help="Time to the first token, and generation rate, under each turn."
            checked={settings.showSpeed}
            onChange={(v) => setSetting("showSpeed", v)}
          />
          <Toggle
            label="Follow the stream"
            help="Scroll with new output unless you have scrolled away yourself."
            checked={settings.autoScroll}
            onChange={(v) => setSetting("autoScroll", v)}
          />
          <Toggle
            label="Collapse long tool output"
            help="Show the first lines of a tool result, with the rest a click away."
            checked={settings.collapseToolOutput}
            onChange={(v) => setSetting("collapseToolOutput", v)}
          />
        </Group>

        <Group title="Branching and alerts">
          <Toggle
            label="Summarize the branch you leave"
            help="When jumping in the tree, carry context from the abandoned path across. Costs one model call per jump."
            checked={settings.summarizeOnJump}
            onChange={(v) => setSetting("summarizeOnJump", v)}
          />
          <Toggle
            label="Notify when a turn finishes"
            help="A desktop notification when an agent settles while you are elsewhere."
            checked={settings.notifyOnSettle}
            onChange={(v) => setSetting("notifyOnSettle", v)}
          />
        </Group>

      </div>
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    // No `overflow-hidden`: the rows hold popovers, and clipping them to the
    // card is what cut the model list off at its edges. The corners round
    // without it because nothing inside paints to them.
    <section className="mb-6 rounded-lg border border-line bg-ink-1">
      <header className="border-b border-line px-4 py-2.5">
        <h2 className="text-md font-medium text-ink-text">{title}</h2>
        {hint ? <p className="mt-0.5 text-sm text-ink-faint">{hint}</p> : null}
      </header>
      <div className="divide-y divide-line/60">{children}</div>
    </section>
  );
}

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-md text-ink-text">{label}</div>
        {help ? <div className="mt-0.5 text-sm text-ink-faint">{help}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-4 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-md text-ink-text">{label}</span>
        {help ? <span className="mt-0.5 block text-sm text-ink-faint">{help}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        // Fixed pixels rather than the spacing scale: a switch is a mechanism
        // whose parts have to line up exactly, not a box on a grid.
        className={`relative h-[20px] w-[36px] shrink-0 rounded-full transition-colors ${
          checked ? "bg-amber" : "bg-ink-3"
        }`}
      >
        <span
          className={`absolute top-[2px] left-[2px] h-[16px] w-[16px] rounded-full transition-transform ${
            checked ? "bg-on-accent translate-x-[16px]" : "bg-ink-text/60 translate-x-0"
          }`}
        />
      </button>
    </label>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-sm border border-line">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`px-2.5 py-1 font-mono text-2xs ${
            value === o.value ? "bg-ink-3 text-ink-text" : "text-ink-faint hover:bg-ink-2 hover:text-ink-dim"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

