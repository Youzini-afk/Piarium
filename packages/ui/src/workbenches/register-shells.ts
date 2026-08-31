/**
 * Workbench shell registration.
 *
 * This module registers built-in workbench shell components with the
 * extension runtime's shell component registry. It is the bridge between
 * the workbenches layer (which owns the shell React components) and the
 * extension runtime (which needs to resolve them by extension ID).
 *
 * Call this before the extension runtime activates shell contributions. The
 * requested Surface loads only the official shells it can actually use.
 */

import {
  PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  type PiariumApplicationSurface,
} from '@piarium/extension-contract';
import { registerWorkbenchShellComponent } from '@/lib/extensions/shell-component-registry';
import { registerBuiltinSettingsWorkbench } from './settings/register';

let agentRegistration: Promise<void> | null = null;
let ideRegistration: Promise<void> | null = null;

const registerAgentShell = (): Promise<void> => {
  if (agentRegistration) return agentRegistration;
  const pending = import('./agent/AgentWorkspaceShell').then(({ AgentWorkspaceShell }) => {
    registerWorkbenchShellComponent(PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID, AgentWorkspaceShell);
  });
  agentRegistration = pending;
  void pending.catch(() => {
    if (agentRegistration === pending) agentRegistration = null;
  });
  return pending;
};

const registerIdeShell = (): Promise<void> => {
  if (ideRegistration) return ideRegistration;
  const pending = import('./ide/IdeWorkbenchShell').then(({ IdeWorkbenchShell }) => {
    registerWorkbenchShellComponent(PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID, IdeWorkbenchShell);
  });
  ideRegistration = pending;
  void pending.catch(() => {
    if (ideRegistration === pending) ideRegistration = null;
  });
  return pending;
};

export const registerWorkbenchShells = async (surface: PiariumApplicationSurface): Promise<void> => {
  registerBuiltinSettingsWorkbench();
  const registrations: Promise<void>[] = [];
  if (surface === 'web' || surface === 'desktop' || surface === 'mobile') {
    registrations.push(registerAgentShell());
  }
  if (surface === 'web' || surface === 'desktop') {
    registrations.push(registerIdeShell());
  }
  await Promise.all(registrations);
};
