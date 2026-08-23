import type { I18nKey } from '@/lib/i18n';

interface RecommendedPackage {
  descriptionKey: I18nKey;
  name: string;
  source: string;
  workbench?: 'fleet';
}

export const RECOMMENDED_PACKAGES: readonly RecommendedPackage[] = [
  {
    name: 'pi-subagents',
    source: 'npm:pi-subagents',
    descriptionKey: 'settings.piarium.plugins.package.subagents',
  },
  {
    name: 'pi-background-tasks',
    source: 'npm:pi-background-tasks',
    descriptionKey: 'settings.piarium.plugins.package.backgroundTasks',
    workbench: 'fleet',
  },
  {
    name: '@cortexkit/pi-magic-context',
    source: 'npm:@cortexkit/pi-magic-context',
    descriptionKey: 'settings.piarium.plugins.package.magicContext',
  },
  {
    name: 'pi-openai-codex-compat',
    source: 'npm:pi-openai-codex-compat',
    descriptionKey: 'settings.piarium.plugins.package.openaiCodexCompat',
  },
  {
    name: 'pi-observational-memory',
    source: 'npm:pi-observational-memory',
    descriptionKey: 'settings.piarium.plugins.package.observationalMemory',
  },
  {
    name: 'context-mode',
    source: 'npm:context-mode',
    descriptionKey: 'settings.piarium.plugins.package.contextMode',
  },
  {
    name: '@cortexkit/aft-pi',
    source: 'npm:@cortexkit/aft-pi',
    descriptionKey: 'settings.piarium.plugins.package.aft',
  },
  {
    name: 'pi-lens',
    source: 'npm:pi-lens',
    descriptionKey: 'settings.piarium.plugins.package.piLens',
  },
  {
    name: '@gotgenes/pi-permission-system',
    source: 'npm:@gotgenes/pi-permission-system',
    descriptionKey: 'settings.piarium.plugins.package.permissionSystem',
  },
  {
    name: 'pi-hermes-memory',
    source: 'npm:pi-hermes-memory',
    descriptionKey: 'settings.piarium.plugins.package.hermesMemory',
  },
  {
    name: 'pi-rtk-optimizer',
    source: 'npm:pi-rtk-optimizer',
    descriptionKey: 'settings.piarium.plugins.package.rtk',
  },
  {
    name: 'pi-mcp-adapter',
    source: 'https://github.com/Youzini-afk/pi-mcp-adapter.git',
    descriptionKey: 'settings.piarium.plugins.package.mcp',
  },
  {
    name: 'pi-web-access',
    source: 'npm:pi-web-access',
    descriptionKey: 'settings.piarium.plugins.package.webAccess',
  },
  {
    name: 'pi-workspace-history',
    source: 'npm:pi-workspace-history',
    descriptionKey: 'settings.piarium.plugins.package.workspaceHistory',
  },
  {
    name: 'pi-wtf',
    source: 'npm:pi-wtf',
    descriptionKey: 'settings.piarium.plugins.package.wtf',
  },
];
