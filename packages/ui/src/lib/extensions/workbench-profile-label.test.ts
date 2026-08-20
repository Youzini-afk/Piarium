import { expect, test } from 'bun:test';
import {
  PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID,
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_LABEL,
} from '@piarium/extension-contract';
import type { I18nKey } from '@/lib/i18n';
import { workbenchExtensionDisplayName, workbenchProfileLabel } from './workbench-profile-label';

const t = (key: I18nKey): string => {
  if (key === 'settings.piarium.extensions.workbench.profile.agent') return '智能体';
  if (key === 'settings.piarium.extensions.workbench.extension.agentWorkspace') return '智能体工作区';
  return key;
};

test('localizes the official Agent profile and keeps custom profile labels', () => {
  expect(workbenchProfileLabel({ id: PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID, label: PIARIUM_WORKBENCH_DEFAULT_PROFILE_LABEL }, t)).toBe('智能体');
  expect(workbenchProfileLabel({ id: PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID, label: 'Default' }, t)).toBe('智能体');
  expect(workbenchProfileLabel({ id: PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID, label: 'Studio Agent' }, t)).toBe('Studio Agent');
  expect(workbenchProfileLabel({ id: 'studio', label: 'Studio' }, t)).toBe('Studio');
});

test('localizes the official Agent Workspace extension display name', () => {
  expect(workbenchExtensionDisplayName({
    manifest: { id: PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID, displayName: 'Agent Workspace' },
  }, t)).toBe('智能体工作区');
  expect(workbenchExtensionDisplayName({
    manifest: { id: 'dev.example.shell', displayName: 'Community Shell' },
  }, t)).toBe('Community Shell');
});
