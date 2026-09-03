import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HarnessSettings } from "@piarium/protocol";
import { createBashTool } from "./bash-tool.js";
import { createGrepTool } from "./grep-tool.js";
import { createApplyPatchTool } from "./apply-patch-tool.js";
import {
  createGetOutputTool,
  createWriteToProcessTool,
  createKillShellTool,
  createDiagnosticsTool,
} from "./output-tools.js";
import { createWebFetchTool } from "./webfetch-tool.js";
import { createWebSearchTool } from "./websearch-tool.js";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { WorkspaceMutationJournalBridge } from "../workspace-mutation-journal.js";

export interface SelectHarnessToolsDeps {
  bridge: HostServicesBridge;
  sessionId: string;
  cwd: string;
  workspaceMutationJournal: WorkspaceMutationJournalBridge | undefined;
  isOpenAIFamily: boolean;
  /** Tools to yield (not register) because a Pi package provides them. */
  yieldedTools?: ReadonlySet<string>;
  /** Whether models.reader is configured (enables webfetch prompt path). */
  readerModelConfigured?: boolean;
}

/**
 * Pure function: given HarnessSettings + deps, returns the list of harness
 * ToolDefinitions to register. session-host calls this; tests verify gating
 * without needing a real session.
 *
 * Override tools (bash, grep) fall back to Pi built-in when disabled — they
 * are simply omitted from the returned list.
 * New tools (get_output, write_to_process, kill_shell, diagnostics,
 * apply_patch) are omitted when disabled.
 * apply_patch is only included when isOpenAIFamily is true AND not disabled.
 * webfetch / websearch are omitted when in yieldedTools (pi-web-access let-in).
 */
export function selectHarnessTools(
  settings: HarnessSettings,
  deps: SelectHarnessToolsDeps,
): ToolDefinition[] {
  const tools = settings.tools;
  const { bridge, sessionId, cwd, workspaceMutationJournal, isOpenAIFamily, yieldedTools, readerModelConfigured } = deps;
  const result: ToolDefinition[] = [];

  if (tools.bash !== false) {
    result.push(createBashTool(bridge, sessionId, cwd));
  }
  if (tools.grep !== false) {
    result.push(createGrepTool(bridge, sessionId));
  }
  if (tools.get_output !== false) {
    result.push(createGetOutputTool(bridge, sessionId));
  }
  if (tools.write_to_process !== false) {
    result.push(createWriteToProcessTool(bridge, sessionId));
  }
  if (tools.kill_shell !== false) {
    result.push(createKillShellTool(bridge, sessionId));
  }
  if (tools.diagnostics !== false) {
    result.push(createDiagnosticsTool(bridge, sessionId));
  }
  if (isOpenAIFamily && tools.apply_patch !== false) {
    result.push(
      createApplyPatchTool(bridge, sessionId, cwd, workspaceMutationJournal),
    );
  }
  // Web tools — yield to pi-web-access if it is loaded and enabled
  if (tools.webfetch !== false && !yieldedTools?.has("webfetch")) {
    result.push(createWebFetchTool(bridge, sessionId, { readerModelConfigured: readerModelConfigured ?? false }));
  }
  if (tools.websearch !== false && !yieldedTools?.has("websearch")) {
    result.push(createWebSearchTool(bridge, sessionId));
  }

  return result;
}

/**
 * Check if pi-web-access is among the loaded and enabled Pi packages.
 * Returns the set of tool names to yield (not register).
 */
export function computeYieldedTools(
  packages: Array<{ name: string; enabled: boolean; source: string }>,
): Set<string> {
  const webAccessLoaded = packages.some(
    (p) =>
      p.enabled &&
      (p.name.toLowerCase().includes("pi-web-access") ||
        p.source.toLowerCase().includes("pi-web-access")),
  );
  if (webAccessLoaded) {
    return new Set(["webfetch", "websearch"]);
  }
  return new Set();
}
