import { DiscoveryError } from "./discovery.js";
import { GeneratedConfigError } from "./generated-config.js";
import type { DiscoveryDiagnostic, DiscoveryFailureSource, StructuredDiagnosticError } from "./types.js";

const REFRESH_CODES = new Set([
  "ODOOLS_DISCOVERY_MISSING_GENERATED_STATE",
  "ODOOLS_DISCOVERY_UNSTABLE_GENERATED_STATE",
  "ODOOLS_DISCOVERY_CONFIG_GENERATED_MISMATCH",
  "ODOOLS_DISCOVERY_WINNER_MISMATCH",
  "ODOOLS_DISCOVERY_GENERATED_NAME_MISMATCH",
]);
const REPAIR_CODES = new Set([
  "ODOOLS_DISCOVERY_AMBIGUOUS_ORDINARY_DUPLICATE",
  "ODOOLS_DISCOVERY_DUPLICATE_EFFECTIVE_NAME",
  "ODOOLS_DISCOVERY_PRECEDENCE_CYCLE",
  "ODOOLS_DISCOVERY_UNSUPPORTED_ADDONS_CONFIG",
  "ODOOLS_DISCOVERY_UNEVALUABLE_ONLY",
  "ODOOLS_DISCOVERY_MISSING_ADDONS_CONFIG",
]);
const UNSAFE_CODES = new Set([
  "ODOOLS_DISCOVERY_BROKEN_GENERATED_TARGET",
  "ODOOLS_DISCOVERY_ESCAPING_GENERATED_TARGET",
  "ODOOLS_DISCOVERY_GENERATED_SYMLINK_LOOP",
  "ODOOLS_DISCOVERY_MALFORMED_GENERATED_TARGET",
]);
const MAX_ACTIONS = 4;

function classifyDiscovery(code: string): Pick<StructuredDiagnosticError, "message" | "recoverable" | "retryAfterRestart" | "actions"> {
  if (REFRESH_CODES.has(code)) return {
    message: "Generated Doodba state is missing, inconsistent, or stale.", recoverable: true, retryAfterRestart: true,
    actions: ["Run `invoke stop start` in the Doodba project.", "Restart OpenCode from the intended workspace location."],
  };
  if (REPAIR_CODES.has(code) || code.includes("AMBIGUOUS") || code.includes("CYCLE") || code.includes("DUPLICATE")) return {
    message: "Workspace discovery found ambiguous or inconsistent addon configuration.", recoverable: true, retryAfterRestart: true,
    actions: ["Repair duplicate, cyclic, or ambiguous addon configuration.", "For Doodba, refresh generated state with `invoke stop start`; otherwise repair the conventional addon roots.", "Restart OpenCode after the configuration is consistent."],
  };
  if (UNSAFE_CODES.has(code) || code.includes("UNSAFE") || code.includes("LINK") || code.includes("ESCAPE")) return {
    message: "Workspace discovery rejected an unsafe path or link.", recoverable: false, retryAfterRestart: false,
    actions: ["Stop and report the unsafe path or link condition; do not auto-repair it."],
  };
  return {
    message: "Odoo workspace discovery failed safely.", recoverable: false, retryAfterRestart: true,
    actions: ["Inspect the workspace markers and addon configuration.", "For Doodba, verify generated state; for a conventional workspace, verify the configured roots.", "Restart OpenCode after the problem is repaired."],
  };
}

function stageFailure(code: string): { message: string; actions: string[]; recoverable: boolean } {
  if (code === "ODOOLS_RUNTIME_CONFIGURATION_FAILED") return {
    message: "The pinned OdooLS runtime could not be verified.", recoverable: true,
    actions: ["Verify or reinstall the pinned odools-mcp runtime.", "Check that the selected runtime directory is complete.", "Restart OpenCode after runtime repair."],
  };
  if (code === "ODOOLS_TEMP_CONFIG_GENERATION_FAILED") return {
    message: "The temporary semantic configuration could not be created safely.", recoverable: true,
    actions: ["Check that the temporary runtime directory is writable and supports private files.", "Restart OpenCode after repairing temporary storage."],
  };
  return {
    message: "The generated semantic adapter configuration failed validation.", recoverable: false,
    actions: ["Stop and report the generated adapter validation failure.", "Repair runtime or workspace configuration before restarting OpenCode."],
  };
}

export function createDiscoveryDiagnostic(error: unknown, source: DiscoveryFailureSource = "filesystem"): DiscoveryDiagnostic {
  let code: string;
  let classified: Pick<StructuredDiagnosticError, "message" | "recoverable" | "retryAfterRestart" | "actions">;
  if (source === "filesystem") {
    code = error instanceof DiscoveryError && /^ODOOLS_DISCOVERY_[A-Z0-9_]+$/.test(error.code) ? error.code : "ODOOLS_DISCOVERY_FAILED";
    classified = classifyDiscovery(code);
  } else {
    code = source === "runtime"
      ? (error instanceof GeneratedConfigError && error.stage === "runtime" ? error.code : "ODOOLS_RUNTIME_CONFIGURATION_FAILED")
      : (error instanceof GeneratedConfigError && error.stage === "temporary-config" ? error.code : "ODOOLS_GENERATED_ADAPTER_INVALID");
    const staged = stageFailure(code);
    classified = { message: staged.message, recoverable: staged.recoverable, retryAfterRestart: staged.recoverable, actions: staged.actions };
  }
  return {
    mode: "discover-workspace", status: "failed", source,
    error: {
      code, message: classified.message.slice(0, 240), recoverable: classified.recoverable,
      retryAfterRestart: classified.retryAfterRestart, details: [],
      actions: classified.actions.slice(0, MAX_ACTIONS).map((action) => action.slice(0, 240)),
    },
  };
}

export function safeDiscoverySummary(diagnostic: DiscoveryDiagnostic): string {
  return `${diagnostic.error.code}: ${diagnostic.error.message}`.slice(0, 320);
}
