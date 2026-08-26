import { describe, expect, test } from 'vitest';
import type { PiConfigTextDocumentSnapshot } from '@piarium/protocol';
import {
  permissionSystemQuickModeContent,
  resolvePermissionSystemQuickMode,
} from './permissionSystemQuickMode';

const snapshot = (
  content: string,
  root: 'agent' | 'project',
  projectTrusted = true,
): PiConfigTextDocumentSnapshot => ({
  content,
  exists: true,
  format: 'jsonc',
  path: root === 'agent'
    ? 'extensions/pi-permission-system/config.json'
    : '.pi/extensions/pi-permission-system/config.json',
  projectTrusted,
  revision: `${root}-revision`,
  root,
});

describe('permission-system quick mode', () => {
  test('uses the trusted project as the Composer write scope while inheriting global mode', () => {
    const state = resolvePermissionSystemQuickMode(
      snapshot('{ "yoloMode": true }\n', 'agent'),
      snapshot('{\n  // project keeps other settings here\n}\n', 'project'),
      true,
    );
    expect(state.mode).toBe('auto');
    expect(state.scope).toBe('project');
    expect(state.source.root).toBe('project');
  });

  test('falls back to the global scope when no trusted workspace is active', () => {
    const state = resolvePermissionSystemQuickMode(
      snapshot('{}\n', 'agent'),
      snapshot('{ "permission": { "path_wrote": "allow" } }\n', 'project', false),
      true,
    );
    expect(state.mode).toBe('ask');
    expect(state.scope).toBe('global');
  });

  test('changes only yoloMode and preserves surrounding JSONC comments', () => {
    const source = snapshot('{\n  // keep policy prose\n  "permission": { "*": "ask" }\n}\n', 'agent');
    const content = permissionSystemQuickModeContent(source, 'auto');
    expect(content).toContain('// keep policy prose');
    expect(content).toContain('"yoloMode": true');
    expect(content).toContain('"permission"');
  });

  test('refuses to rewrite a config the plugin would reject', () => {
    const source = snapshot('{ "permission": { "path_wrote": "allow" } }\n', 'agent');
    expect(() => permissionSystemQuickModeContent(source, 'auto')).toThrow(
      'Permission configuration must be fixed before changing quick mode',
    );
  });
});
