export type JsonRpcId = number | string;
export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface Location { uri: string; range: Range }
export interface LocationLink { targetUri: string; targetRange: Range; targetSelectionRange: Range }
export type NavigationResult = Location | LocationLink | Array<Location | LocationLink> | null;
export type JavascriptState = "disabled" | "pending" | "ready" | "unavailable";

export interface ReadinessSnapshot {
  state: "dormant" | "activating" | "indexing" | "restarting" | "ready" | "degraded" | "failed" | "stopping" | "stopped";
  coreReady: boolean;
  javascriptReady: boolean;
  javascriptState: JavascriptState;
  loading: boolean;
  progressActive: number;
  configurationSeen: boolean;
  configurationDiagnostics: string[];
  javascriptDiagnostics: string[];
  fatalConfiguration: boolean;
  processAlive: boolean;
  lastActivityAt: number;
  automaticRestart: boolean;
  restartCount: number;
  lastCrash: string | null;
  lastError: string | null;
  watcherEnabled: boolean;
  watcherState: "disabled" | "starting" | "watching" | "stopped" | "failed";
  watcherError: string | null;
  watcherDocumentCount: number;
  maxWatcherDocuments: number;
}

export interface DiscoveredOdooWorkspace {
  /** Authoritative workspace root (for Doodba: exactly <doodba-root>/odoo/custom/src) */
  workspace: string;
  /** Canonical path to Odoo core (odoo-bin + base manifest) */
  odooPath: string;
  /** Canonical, deduplicated, sorted immediate-child addon roots inside workspace */
  addonRoots: string[];
  /** Whether this is a validated Doodba structure */
  isDoodba: boolean;
  /** Resolved Python executable (CLI > .venv > python3) */
  python: string;
}

export interface GeneratedOdooConfig {
  /** Raw object suitable for loadConfig() */
  adapter: Record<string, unknown>;
  /** Path to the authoritative temporary odools.toml (private, 0600, outside customer tree) */
  tomlPath: string;
  /** Narrow cleanup hook for lifecycle (temp dir/file removal) */
  cleanup: () => Promise<void>;
}
