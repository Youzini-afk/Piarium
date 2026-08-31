/**
 * Workbench shell registration.
 *
 * This module registers built-in workbench shell components with the
 * extension runtime's shell component registry. It is the bridge between
 * the workbenches layer (which owns the shell React components) and the
 * extension runtime (which needs to resolve them by extension ID).
 *
 * Import this module once during application initialization, before
 * the extension runtime activates any shell contributions.
 */

import { AgentWorkspaceShell } from './agent/AgentWorkspaceShell';
import { IdeWorkbenchShell } from './ide/IdeWorkbenchShell';
import {
  PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
} from '@piarium/extension-contract';
import { registerWorkbenchShellComponent } from '@/lib/extensions/shell-component-registry';

let registered = false;

export const registerWorkbenchShells = (): void => {
  if (registered) return;
  registerWorkbenchShellComponent(PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID, AgentWorkspaceShell);
  registerWorkbenchShellComponent(PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID, IdeWorkbenchShell);
  registered = true;
};
