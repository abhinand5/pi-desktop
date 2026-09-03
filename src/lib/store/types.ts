/**
 * Shared store types.
 *
 * The app runs one zustand store composed from slices, so components keep a
 * single `useAppStore` while each concern — runtime lifecycle, catalogs, the
 * session tree, the command registry, panels — owns its own file.
 */

import type { ModelInfo, SessionSummary } from "../agent-state";
import type {
  DefaultModelRef,
  HarnessId,
  PtyProgram,
  HostEntry,
  ImageAttachment,
  ProviderConfig,
  ProviderEntry,
  ProviderTestResult,
  SessionTree,
  TreeNode,
} from "../bridge";
import type { ProjectKind, ProjectWorkspace, Workspace, WorkspaceKind, WorkspaceProjection } from "./workspace";

/** Remote-session verdict after contact loss (orca-style semantics). */
export type Verdict = "live" | "unverifiable" | "exited" | null;

export interface RuntimeSlice extends WorkspaceProjection {
  /** Project containers, keyed by `projectKey(target, cwd)` — a path on one
   *  machine is a different project from the same path on another. */
  projects: Record<string, ProjectWorkspace>;
  /** Which machine's work the rail is showing. Null is this machine. */
  activeMachine: string | null;
  /** Every open session workspace, live or idle, keyed by id. */
  workspaces: Record<string, Workspace>;
  /** Sidebar order — most recently used first. */
  workspaceOrder: string[];
  activeWorkspaceId: string | null;

  openWorkspace(init: {
    cwd: string;
    harness?: HarnessId;
    target?: string | null;
    sessionPath?: string | null;
    /** Skip the one-workspace-per-folder rule and open a second one anyway. */
    fresh?: boolean;
    kind?: WorkspaceKind;
    program?: PtyProgram;
    projectKind?: ProjectKind;
  }): string;
  /** Starts a fresh local session in the app-owned scratch root. */
  openScratchWorkspace(): Promise<string | null>;
  /** A terminal in a folder. Always its own workspace — you open a second
   *  terminal because you want a second terminal. */
  openTerminal(init: { cwd: string; program: PtyProgram; target?: string | null }): string;
  activateWorkspace(id: string): void;
  /** Closes one session tab while preserving the project and session file. */
  closeWorkspace(id: string): Promise<void>;
  /** Hides a project and closes all of its session tabs. Takes a `projectKey`. */
  archiveProject(key: string): Promise<void>;
  /** Removes a project from the app without touching its files. Takes a `projectKey`. */
  deleteProject(key: string): Promise<void>;
  /** Makes an archived project visible again. Takes a `projectKey`. */
  restoreProject(key: string): void;

  setHarness(harness: HarnessId): void;
  setCwd(cwd: string): void;
  /** Moves to a machine. Never starts, stops, or re-points a session — what is
   *  running on the machine you leave goes on running. */
  setMachine(alias: string | null): void;
  startRuntime(): Promise<void>;
  stopRuntime(): Promise<void>;
  reconnect(): Promise<void>;
  resumeSession(session: SessionSummary): Promise<void>;
  continueLastSession(): Promise<void>;
  replayHistory(): Promise<void>;
  sendPrompt(text: string, images?: ImageAttachment[]): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  rawCommand(command: Record<string, unknown>): Promise<unknown>;
  respondApproval(payload: Record<string, unknown>): Promise<void>;
  refreshContext(): Promise<void>;
  refreshStats(): Promise<void>;
  captureSessionFile(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  newSession(): Promise<void>;
  renameSession(name: string): Promise<void>;
  exportSession(): Promise<string | null>;
  runBash(command: string): Promise<BashResult | null>;
  abortBash(): Promise<void>;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  totalMessages?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  cost?: number;
  contextUsage?: { tokens?: number; contextWindow?: number; percent?: number };
}

export interface BashResult {
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}

export interface CatalogSlice {
  models: ModelInfo[];
  modelsError: string | null;
  /** `harness@machine` the loaded catalog belongs to, so a stale reply from a
   *  machine you have since left cannot overwrite the one you are on. */
  modelsFor: string | null;
  /** The harness's own default model, read from its native config. */
  harnessDefault: DefaultModelRef | null;
  sessions: SessionSummary[];
  providers: ProviderEntry[];
  hosts: HostEntry[];

  loadModels(): Promise<void>;
  selectModel(model: ModelInfo): Promise<void>;
  loadHarnessDefault(): Promise<void>;
  /** Writes the harness-level default model. Applies to every new session. */
  setDefaultModel(model: DefaultModelRef | null): Promise<void>;
  setThinking(level: string): Promise<void>;
  refreshSessions(): Promise<void>;
  deleteSession(path: string): Promise<void>;
  loadHosts(): Promise<void>;
  addHost(alias: string, destination: string, port: number | null): Promise<void>;
  removeHost(alias: string): Promise<void>;
  loadProviders(): Promise<void>;
  saveProvider(id: string, config: ProviderConfig): Promise<void>;
  deleteProvider(id: string): Promise<void>;
  testProviderConnection(baseUrl: string, apiKey: string | null): Promise<ProviderTestResult>;
}

export interface TreeSlice {
  refreshTree(): Promise<void>;
  /** Moves the session leaf. A user entry lands on its parent and returns its
   *  text for the composer; anything else lands on itself. */
  gotoEntry(entryId: string, options?: { summarize?: boolean; customInstructions?: string }): Promise<string | null>;
  labelEntry(entryId: string, label: string): Promise<void>;
  /** Re-runs a prompt as a new sibling branch. */
  retryEntry(entryId: string, text?: string): Promise<void>;
  forkFrom(entryId: string): Promise<void>;
  cloneSession(): Promise<void>;
}

export interface CommandsSlice {
  loadCommands(): Promise<void>;
}

export type PanelId = "providers" | "files" | "status" | "terminal" | "tree" | "history";
export type Route = "chat" | "settings" | "usage";

/** How thinking is shown while it streams. Inline is the default: one live
 *  line, so reasoning is visible without opening anything. */
export type ThinkingDisplay = "inline" | "collapsed" | "hidden";
/** How smoothly the inline line glides. A floor, not a cap: the reveal
 *  accelerates to stay level with a fast model rather than falling behind. */
export type ThinkingPace = "instant" | "readable" | "slow";

/**
 * The palettes in `index.css`. Adding one is a CSS block plus an entry here.
 *
 * Most are ports of schemes that already exist — Nord, Gruvbox, Tokyo Night,
 * Catppuccin and the rest — at their published values. A palette thousands of
 * people read code in every day has been tested in a way a fresh one has not.
 *
 * `light` is not decoration: syntax highlighting ships both a light and a dark
 * set of token colours in the same markup, and this is what chooses between
 * them. It is also what tells the palette's elevation ladder which way up it
 * goes.
 */
export const THEMES = [
  { id: "foundry", label: "Foundry", hint: "Jade on slate", light: false },
  { id: "phosphor", label: "Phosphor", hint: "Amber on graphite", light: false },
  { id: "tokyo-night", label: "Tokyo Night", hint: "Blue on midnight", light: false },
  { id: "mocha", label: "Mocha", hint: "Catppuccin", light: false },
  { id: "nord", label: "Nord", hint: "Arctic blue", light: false },
  { id: "gruvbox", label: "Gruvbox", hint: "Warm retro", light: false },
  { id: "rose-pine", label: "Rosé Pine", hint: "Muted rose", light: false },
  { id: "everforest", label: "Everforest", hint: "Soft green", light: false },
  { id: "one-dark", label: "One Dark", hint: "Atom", light: false },
  { id: "dracula", label: "Dracula", hint: "Violet on charcoal", light: false },
  { id: "kanagawa", label: "Kanagawa", hint: "Ink wash", light: false },
  { id: "solarized", label: "Solarized", hint: "Precision cyan", light: false },
  { id: "foundry-day", label: "Foundry Day", hint: "Jade on white", light: true },
  { id: "latte", label: "Latte", hint: "Catppuccin light", light: true },
  { id: "solarized-light", label: "Solarized Light", hint: "Warm paper", light: true },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", hint: "Blush light", light: true },
  { id: "gruvbox-light", label: "Gruvbox Light", hint: "Warm retro light", light: true },
] as const satisfies ReadonlyArray<{ id: string; label: string; hint: string; light: boolean }>;

export type ThemeId = (typeof THEMES)[number]["id"];

export interface Settings {
  theme: ThemeId;
  /** Overrides the terminal's font stack. Empty means the built-in one, which
   *  already prefers a Nerd Font Mono so TUI glyphs render. */
  terminalFont: string;
  /** Optional root for generic scratch sessions. Empty uses the app-owned default. */
  scratchWorkspacePath: string;

  /** Frosts the chrome and floating panels. The transcript stays opaque. */
  glass: boolean;
  thinkingDisplay: ThinkingDisplay;
  thinkingPace: ThinkingPace;
  /** Tokens per second and prompt-processing time under each turn. */
  showSpeed: boolean;
  /** Follow the stream unless you have scrolled away. */
  autoScroll: boolean;
  notifyOnSettle: boolean;
  /** Offer to summarize the branch you leave when jumping in the tree. */
  summarizeOnJump: boolean;
  /** Reading column width for the transcript. */
  transcriptWidth: "narrow" | "wide";
  /** How much air the interface takes. Comfortable is the authored spacing;
   *  compact tightens the parts that scale, for a small window or a long day. */
  density: "comfortable" | "compact";
  /** Show tool output collapsed until asked for. */
  collapseToolOutput: boolean;
}

export const defaultSettings: Settings = {
  theme: "foundry",
  terminalFont: "",
  scratchWorkspacePath: "",
  glass: false,
  thinkingDisplay: "inline",
  thinkingPace: "readable",
  showSpeed: true,
  autoScroll: true,
  notifyOnSettle: true,
  summarizeOnJump: false,
  transcriptWidth: "narrow",
  density: "comfortable",
  collapseToolOutput: true,
};

export interface UiSlice {
  route: Route;
  openPanel: PanelId | null;
  commandPaletteOpen: boolean;
  showAddHost: boolean;
  sidebarOpen: boolean;
  /** Node the tree rail has selected, independent of the live leaf. */
  selectedNodeId: string | null;
  notice: string | null;

  setRoute(route: Route): void;
  setPanel(panel: PanelId | null): void;
  togglePanel(panel: PanelId): void;
  setCommandPaletteOpen(open: boolean): void;
  setShowAddHost(open: boolean): void;
  toggleSidebar(): void;
  setComposerDraft(text: string | null): void;
  setSelectedNode(id: string | null): void;
  setNotice(text: string | null): void;
}

export interface SettingsSlice {
  settings: Settings;
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  resetSettings(): void;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ModelUsage {
  model: string;
  messages: number;
  tokens: Tokens;
  cost: number;
}

export interface DayUsage {
  date: string;
  sessions: number;
  messages: number;
  tokens: number;
}

/** One machine's share of a report that spans several. */
export interface MachineUsage {
  machine: string;
  sessions: number;
  messages: number;
  tokens: Tokens;
  cost: number;
}

/** Aggregate usage, derived from the harness's own session files. */
export interface UsageReport {
  sessions: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokens: Tokens;
  cost: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  favoriteModel: string | null;
  byModel: ModelUsage[];
  /** Where the work happened. One row per machine that was scanned. */
  byMachine: MachineUsage[];
  /** Machines that could not be read this time, named rather than dropped. */
  unreachable: string[];
  byDay: DayUsage[];
  firstDay: string | null;
  lastDay: string | null;
}

export type UsageWindow = "all" | "30d" | "7d";

export interface UsageSlice {
  usage: UsageReport | null;
  /** Which agent's session files the report covers. */
  usageHarness: "all" | HarnessId;
  usageWindow: UsageWindow;
  usageLoading: boolean;
  usageError: string | null;
  setUsageHarness(harness: "all" | HarnessId): void;
  setUsageWindow(window: UsageWindow): void;
  loadUsage(): Promise<void>;
}

export type AppStore = RuntimeSlice &
  CatalogSlice &
  TreeSlice &
  CommandsSlice &
  UiSlice &
  SettingsSlice &
  UsageSlice;

/** Slice creator, typed against the whole store so slices can call each other. */
export type SliceOf<T> = (
  set: (partial: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => void,
  get: () => AppStore,
) => T;

export type { TreeNode, SessionTree };
export type { Workspace } from "./workspace";
