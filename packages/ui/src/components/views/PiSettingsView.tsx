import React from 'react';
import { AgentsPage } from '@/components/sections/agents/AgentsPage';
import { McpPage } from '@/components/sections/mcp/McpPage';
import { PluginSettingsPage } from '@/components/sections/plugin-settings';
import { PluginsPage } from '@/components/sections/plugins';
import { PromptsPage } from '@/components/sections/prompts/PromptsPage';
import { PromptsSidebar } from '@/components/sections/prompts/PromptsSidebar';
import { ProvidersPage } from '@/components/sections/providers/ProvidersPage';
import { ProvidersSidebar } from '@/components/sections/providers/ProvidersSidebar';
import { RecoverySettings } from '@/components/sections/openchamber/RecoverySettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SkillsPage } from '@/components/sections/skills/SkillsPage';
import { SkillsSidebar } from '@/components/sections/skills/SkillsSidebar';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { McpIcon } from '@/components/icons/McpIcon';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

type PiSettingsPage =
  | 'sessions'
  | 'providers'
  | 'agents'
  | 'prompts'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'plugin-settings'
  | 'about';

type PageDefinition = {
  icon: IconName | 'mcp';
  page: PiSettingsPage;
  titleKey:
    | 'settings.page.sessions.title'
    | 'settings.page.providers.title'
    | 'settings.page.agents.title'
    | 'settings.page.prompts.title'
    | 'settings.page.skills.title'
    | 'settings.page.mcp.title'
    | 'settings.page.plugins.title'
    | 'settings.page.pluginSettings.title'
    | 'settings.page.about.title';
};

const PAGES: readonly PageDefinition[] = [
  { page: 'sessions', icon: 'chat-history', titleKey: 'settings.page.sessions.title' },
  { page: 'providers', icon: 'cloud', titleKey: 'settings.page.providers.title' },
  { page: 'agents', icon: 'robot-2', titleKey: 'settings.page.agents.title' },
  { page: 'prompts', icon: 'file-text', titleKey: 'settings.page.prompts.title' },
  { page: 'skills', icon: 'sparkling', titleKey: 'settings.page.skills.title' },
  { page: 'mcp', icon: 'mcp', titleKey: 'settings.page.mcp.title' },
  { page: 'plugins', icon: 'plug-2', titleKey: 'settings.page.plugins.title' },
  { page: 'plugin-settings', icon: 'settings-3', titleKey: 'settings.page.pluginSettings.title' },
  { page: 'about', icon: 'information', titleKey: 'settings.page.about.title' },
];

const PAGE_IDS = new Set<PiSettingsPage>(PAGES.map(({ page }) => page));
const isPiSettingsPage = (value: string): value is PiSettingsPage => PAGE_IDS.has(value as PiSettingsPage);

interface PiSettingsViewProps {
  forceMobile?: boolean;
  isWindowed?: boolean;
  onClose?: () => void;
}

export const PiSettingsView: React.FC<PiSettingsViewProps> = ({ forceMobile = false, onClose }) => {
  const { t } = useI18n();
  const rawPage = useUIStore((state) => state.settingsPage);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const activePage: PiSettingsPage = isPiSettingsPage(rawPage) ? rawPage : 'sessions';
  const [mobileNavigationOpen, setMobileNavigationOpen] = React.useState(false);

  React.useEffect(() => {
    if (!isPiSettingsPage(rawPage)) setSettingsPage('sessions');
  }, [rawPage, setSettingsPage]);

  const openPage = React.useCallback((page: PiSettingsPage) => {
    setSettingsPage(page);
    setMobileNavigationOpen(false);
  }, [setSettingsPage]);

  const renderSidebar = React.useCallback(() => {
    switch (activePage) {
      case 'providers': return <ProvidersSidebar onItemSelect={() => setMobileNavigationOpen(false)} />;
      case 'prompts': return <PromptsSidebar onItemSelect={() => setMobileNavigationOpen(false)} />;
      case 'skills': return <SkillsSidebar onItemSelect={() => setMobileNavigationOpen(false)} />;
      default: return null;
    }
  }, [activePage]);

  const renderContent = React.useCallback(() => {
    switch (activePage) {
      case 'providers': return <ProvidersPage />;
      case 'agents': return <AgentsPage />;
      case 'prompts': return <PromptsPage />;
      case 'skills': return <SkillsPage />;
      case 'mcp': return <McpPage />;
      case 'plugins': return <PluginsPage />;
      case 'plugin-settings': return <PluginSettingsPage />;
      case 'sessions':
        return (
          <SettingsPageLayout title={t('settings.page.sessions.title')} showSaveStatus>
            <RecoverySettings />
          </SettingsPageLayout>
        );
      case 'about':
        return (
          <SettingsPageLayout title="Piarium" showSaveStatus={false}>
            <section className="space-y-3 border-t border-border/60 pt-6 first:border-t-0 first:pt-0">
              <p className="typography-ui text-foreground">
                Pi-native workspace for sessions, providers, agents, prompts, skills, MCP and extensions.
              </p>
              <p className="typography-meta text-muted-foreground">
                Runtime configuration is read directly from Pi; plugin-owned settings remain authoritative.
              </p>
            </section>
          </SettingsPageLayout>
        );
    }
  }, [activePage, t]);

  const pageSidebar = renderSidebar();
  const navigation = (
    <nav className="flex h-full min-h-0 flex-col overflow-y-auto bg-sidebar px-3 py-3" aria-label={t('settings.view.home.title')}>
      <div className="mb-2 px-2 typography-ui-label font-semibold text-foreground">Piarium</div>
      <div className="space-y-0.5">
        {PAGES.map((definition) => {
          const selected = activePage === definition.page;
          return (
            <button
              key={definition.page}
              type="button"
              onClick={() => openPage(definition.page)}
              aria-current={selected ? 'page' : undefined}
              className={cn(
                'flex h-9 w-full items-center gap-2 rounded-md px-2 text-left typography-ui-label',
                selected ? 'bg-interactive-selection text-foreground' : 'text-foreground hover:bg-interactive-hover',
              )}
            >
              {definition.icon === 'mcp'
                ? <McpIcon className="size-4 shrink-0" />
                : <Icon name={definition.icon} className="size-4 shrink-0" />}
              <span className="truncate">{t(definition.titleKey)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      {forceMobile && (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md hover:bg-interactive-hover"
            onClick={() => setMobileNavigationOpen((open) => !open)}
            aria-label={t('settings.view.actions.openSectionList')}
          >
            <Icon name={mobileNavigationOpen ? 'close' : 'menu-2'} className="size-4" />
          </button>
          <span className="min-w-0 flex-1 truncate typography-ui-label font-medium">
            {t(PAGES.find(({ page }) => page === activePage)?.titleKey ?? 'settings.page.sessions.title')}
          </span>
          {onClose && (
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-md hover:bg-interactive-hover"
              onClick={onClose}
              aria-label={t('settings.view.actions.closeSettings')}
            >
              <Icon name="close" className="size-4" />
            </button>
          )}
        </header>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {(!forceMobile || mobileNavigationOpen) && (
          <aside className={cn(
            'h-full min-h-0 shrink-0 border-r border-border',
            forceMobile ? 'w-full' : 'w-56',
          )}>
            <ErrorBoundary>{navigation}</ErrorBoundary>
          </aside>
        )}
        {(!forceMobile || !mobileNavigationOpen) && (
          <main className="flex min-w-0 flex-1 overflow-hidden">
            {pageSidebar && (
              <aside className="h-full w-64 shrink-0 overflow-hidden border-r border-border bg-background">
                <ErrorBoundary>{pageSidebar}</ErrorBoundary>
              </aside>
            )}
            <div className="min-w-0 flex-1 overflow-hidden">
              <ErrorBoundary>{renderContent()}</ErrorBoundary>
            </div>
          </main>
        )}
      </div>

      {!forceMobile && onClose && (
        <button
          type="button"
          className="absolute right-2 top-2 z-20 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
          onClick={onClose}
          aria-label={t('settings.view.actions.closeSettings')}
        >
          <Icon name="close" className="size-4" />
        </button>
      )}
    </div>
  );
};
