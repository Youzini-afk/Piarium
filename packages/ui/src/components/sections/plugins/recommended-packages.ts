import type { I18nKey } from '@/lib/i18n';

interface RecommendedPackage {
  descriptionKey: I18nKey;
  name: string;
  source: string;
}

export const RECOMMENDED_PACKAGES: readonly RecommendedPackage[] = [
  {
    name: 'pi-subagents',
    source: 'npm:pi-subagents',
    descriptionKey: 'settings.piarium.plugins.package.subagents',
  },
  {
    name: '@cortexkit/pi-magic-context',
    source: 'npm:@cortexkit/pi-magic-context',
    descriptionKey: 'settings.piarium.plugins.package.magicContext',
  },
  {
    name: 'pi-openai-codex-compat',
    source: 'npm:pi-openai-codex-compat@alpha',
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
