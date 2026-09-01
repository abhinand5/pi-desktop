/**
 * Shared store types.
 *
 * The app runs one zustand store composed from slices, so components keep a
 * single `useAppStore` while each concern — runtime lifecycle, catalogs, the
 * session tree, the command registry, panels — owns its own file.
 */

import type { ModelInfo, SessionSummary } from "../agent-state";
import type {
  HarnessId,
  HostEntry,
  ImageAttachment,
  ProviderConfig,
  ProviderEntry,
  ProviderTestResult,
  SessionTree,
  TreeNode,
} from "../bridge";
import type { Workspace, WorkspaceProjection } from "./workspace";

/** Remote-session verdict after contact loss (orca-style semantics). */
export type Verdict = "live" | "unverifiable" | "exited" | null;

export interface RuntimeSlice extends WorkspaceProjection {
  /** Every open workspace, live or idle, keyed by id. */
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
  }): string;
  activateWorkspace(id: string): void;
  closeWorkspace(id: string): Promise<void>;

  setHarness(harness: HarnessId): void;
  setCwd(cwd: string): void;
  setTarget(alias: string | null): void;
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
  sessions: SessionSummary[];
  providers: ProviderEntry[];
  hosts: HostEntry[];

  loadModels(): Promise<void>;
  selectModel(model: ModelInfo): Promise<void>;
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
 * `light` is not decoration: syntax highlighting ships both a light and a dark
 * set of token colours in the same markup, and this is what chooses between
 * them.
 */
export const THEMES = [
  { id: "phosphor", label: "Phosphor", hint: "Amber on graphite", light: false },
  { id: "ember", label: "Ember", hint: "Warm charcoal", light: false },
  { id: "nocturne", label: "Nocturne", hint: "Deep indigo", light: false },
  { id: "moss", label: "Moss", hint: "Green and lime", light: false },
  { id: "mono", label: "Mono", hint: "Neutral, quiet", light: false },
  { id: "paper", label: "Paper", hint: "Light", light: true },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export interface Settings {
  theme: ThemeId;
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
  /** Show tool output collapsed until asked for. */
  collapseToolOutput: boolean;
}

export const defaultSettings: Settings = {
  theme: "phosphor",
  glass: false,
  thinkingDisplay: "inline",
  thinkingPace: "readable",
  showSpeed: true,
  autoScroll: true,
  notifyOnSettle: true,
  summarizeOnJump: false,
  transcriptWidth: "narrow",
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
  byDay: DayUsage[];
  firstDay: string | null;
  lastDay: string | null;
}

export type UsageWindow = "all" | "30d" | "7d";

export interface UsageSlice {
  usage: UsageReport | null;
  usageWindow: UsageWindow;
  usageLoading: boolean;
  usageError: string | null;
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
