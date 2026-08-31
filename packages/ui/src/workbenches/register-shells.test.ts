import { describe, expect, it } from 'vitest';
import {
  PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
} from '@piarium/extension-contract';
import { resolveWorkbenchShellComponent } from '@/lib/extensions/shell-component-registry';
import { ensureBuiltinSettingsContributions } from '@/lib/settings/surface-registry';
import { registerWorkbenchShells } from './register-shells';

describe('production workbench registration', () => {
  it('registers both built-in shells and the Settings composition source', async () => {
    await registerWorkbenchShells('web');
    expect(resolveWorkbenchShellComponent(PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID)).toBeTruthy();
    expect(resolveWorkbenchShellComponent(PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID)).toBeTruthy();
    await expect(ensureBuiltinSettingsContributions()).resolves.toBeUndefined();
  });
});
