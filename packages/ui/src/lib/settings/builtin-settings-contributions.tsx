import type { SurfaceActivationContext } from '@piarium/extension-surface';
import { CommandsPage } from '@/components/sections/commands/CommandsPage';
import { PromptsSidebar } from '@/components/sections/prompts/PromptsSidebar';
import { PromptsPage } from '@/components/sections/prompts/PromptsPage';
import { SkillsSidebar } from '@/components/sections/skills/SkillsSidebar';
import { SkillsPage } from '@/components/sections/skills/SkillsPage';
import { PluginsPage } from '@/components/sections/plugins';
import { ExtensionsPage } from '@/components/sections/extensions/ExtensionsPage';
import { ProjectsSidebar } from '@/components/sections/projects/ProjectsSidebar';
import { ProjectsPage } from '@/components/sections/projects/ProjectsPage';
import { RemoteInstancesPage } from '@/components/sections/remote-instances/RemoteInstancesPage';
import { ProvidersSidebar } from '@/components/sections/providers/ProvidersSidebar';
import { ProvidersPage } from '@/components/sections/providers/ProvidersPage';
import { PiRuntimeSettingsPage } from '@/components/sections/runtime/PiRuntimeSettingsPage';
import { UsageSidebar } from '@/components/sections/usage/UsageSidebar';
import { UsagePage } from '@/components/sections/usage/UsagePage';
import { MagicPromptsSidebar } from '@/components/sections/magic-prompts/MagicPromptsSidebar';
import { MagicPromptsPage } from '@/components/sections/magic-prompts/MagicPromptsPage';
import { SnippetsSidebar } from '@/components/sections/snippets/SnippetsSidebar';
import { SnippetsPage } from '@/components/sections/snippets/SnippetsPage';
import { GitPage } from '@/components/sections/git-identities/GitPage';
import type { PiariumSettingsSection } from '@/components/sections/piarium/types';
import { PiariumSettingsPage } from '@/components/sections/piarium/PiariumSettingsPage';
import { BuiltinAboutSettingsPage } from './BuiltinAboutSettingsPage';
import type { SettingsPageImplementation, SettingsPageMeta, SettingsRuntimeContext } from './page-types';

export const BUILTIN_SETTINGS_EXTENSION_ID = 'piarium.builtin.settings';

interface BuiltinPageDefinition {
  implementation: SettingsPageImplementation;
  meta: SettingsPageMeta;
}

const piariumPage = (section: PiariumSettingsSection): SettingsPageImplementation => ({
  renderContent: () => <PiariumSettingsPage section={section} />,
});

const page = (
  meta: SettingsPageMeta,
  implementation: SettingsPageImplementation,
): BuiltinPageDefinition => ({ meta, implementation });

const notVSCode = (ctx: SettingsRuntimeContext) => !ctx.isVSCode;

export const BUILTIN_SETTINGS_PAGES: readonly BuiltinPageDefinition[] = [
  page({ slug: 'home', title: 'Settings', titleKey: 'settings.view.home.title', group: 'general', kind: 'single', icon: null, order: -1, keywords: ['search', 'settings'] }, { renderContent: () => null }),
  page({ slug: 'general', title: 'General', titleKey: 'settings.page.general.title', group: 'general', kind: 'single', icon: 'settings-3', order: 0, keywords: ['general', 'startup', 'launch at login', 'autostart', 'tray', 'password', 'passkey', 'security', 'transport', 'network', 'lan'] }, piariumPage('general')),
  page({ slug: 'appearance', title: 'Appearance', titleKey: 'settings.page.appearance.title', group: 'general', kind: 'single', icon: 'palette', order: 1, keywords: ['theme', 'font', 'spacing', 'padding', 'corner radius', 'radius', 'input bar', 'keyboard', 'viewport', 'mobile', 'terminal', 'pwa', 'install name', 'app shortcuts'] }, piariumPage('visual')),
  page({ slug: 'chat', title: 'Chat', titleKey: 'settings.page.chat.title', group: 'general', kind: 'single', icon: 'chat-ai-3', order: 2, keywords: ['tools', 'diff', 'reasoning', 'dotfiles', 'draft', 'queue', 'output', 'copy', 'image', 'split messages', 'message actions'] }, piariumPage('chat')),
  page({ slug: 'notifications', title: 'Notifications', titleKey: 'settings.page.notifications.title', group: 'general', kind: 'single', icon: 'notification-3', order: 3, keywords: ['alerts', 'native', 'summary', 'summarization'] }, piariumPage('notifications')),
  page({ slug: 'sessions', title: 'Sessions', titleKey: 'settings.page.sessions.title', group: 'general', kind: 'single', icon: 'chat-history', order: 4, keywords: ['defaults', 'default agent', 'default model', 'retention', 'memory', 'zen', 'recovery', 'rollback', 'undo', 'checkpoint', 'workspace snapshot'] }, piariumPage('sessions')),
  page({ slug: 'shortcuts', title: 'Shortcuts', titleKey: 'settings.page.shortcuts.title', group: 'general', kind: 'single', icon: 'command', order: 5, keywords: ['keyboard', 'hotkeys', 'shortcuts', 'bindings'] }, { ...piariumPage('shortcuts'), isAvailable: (ctx) => !ctx.isVSCode && !ctx.isMobile }),
  page({ slug: 'voice', title: 'Voice', titleKey: 'settings.page.voice.title', group: 'general', kind: 'single', icon: 'mic', order: 6, keywords: ['tts', 'speech', 'voice'] }, { ...piariumPage('voice'), isAvailable: notVSCode }),
  page({ slug: 'usage', title: 'Usage', titleKey: 'settings.page.usage.title', group: 'general', kind: 'split', icon: 'bar-chart-2', order: 7, keywords: ['quota', 'billing', 'tokens', 'usage', 'limits'] }, { renderContent: () => <UsagePage />, renderSidebar: (options) => <UsageSidebar onItemSelect={options.onItemSelect} /> }),
  page({ slug: 'about', title: 'About', titleKey: 'settings.page.about.title', group: 'general', kind: 'single', icon: 'information', order: 8, keywords: ['about', 'version', 'updates', 'release', 'changelog'] }, {
    isAvailable: (ctx) => ctx.isMobile && !ctx.isVSCode,
    renderContent: () => <BuiltinAboutSettingsPage />,
  }),
  page({ slug: 'projects', title: 'Projects', titleKey: 'settings.page.projects.title', group: 'projects', kind: 'split', icon: 'folders', order: 20, keywords: ['project', 'projects', 'worktree', 'worktrees', 'repo', 'repository', 'directory'] }, { isAvailable: notVSCode, renderContent: () => <ProjectsPage />, renderSidebar: (options) => <ProjectsSidebar onItemSelect={options.onItemSelect} /> }),
  page({ slug: 'remote-instances', title: 'Remote Instances', titleKey: 'settings.page.remoteInstances.title', group: 'projects', kind: 'single', icon: 'computer', order: 21, keywords: ['ssh', 'remote', 'instances', 'tunnels', 'forwarding', 'connection'] }, { isAvailable: notVSCode, renderContent: () => <RemoteInstancesPage /> }),
  page({ slug: 'tunnel', title: 'External Tunnel', titleKey: 'settings.page.tunnel.title', group: 'projects', kind: 'single', icon: 'home-office', order: 22, badgeKey: 'settings.view.badge.beta', keywords: ['tunnel', 'external', 'cloudflare', 'qr', 'remote', 'mobile', 'share'] }, { ...piariumPage('tunnel'), isAvailable: notVSCode }),
  page({ slug: 'git', title: 'Git', titleKey: 'settings.page.git.title', group: 'projects', kind: 'single', icon: 'git-branch', order: 23, keywords: ['git', 'github', 'identity', 'identities', 'ssh', 'profiles', 'credentials', 'keys', 'commit', 'gitmoji', 'oauth', 'prs', 'issues'] }, { isAvailable: notVSCode, renderContent: () => <GitPage /> }),
  page({ slug: 'runtime', title: 'Runtime', titleKey: 'settings.page.runtime.title', group: 'pi', kind: 'single', icon: 'terminal-box', order: 39, keywords: ['pi', 'runtime', 'install', 'upgrade', 'node', 'path', 'package root'] }, { renderContent: () => <PiRuntimeSettingsPage /> }),
  page({ slug: 'providers', title: 'Providers', titleKey: 'settings.page.providers.title', group: 'pi', kind: 'split', icon: 'cloud', order: 40, keywords: ['provider', 'providers', 'models', 'model', 'api key', 'api keys', 'openai', 'anthropic', 'ollama', 'credentials'] }, { renderContent: () => <ProvidersPage />, renderSidebar: (options) => <ProvidersSidebar onItemSelect={options.onItemSelect} /> }),
  page({ slug: 'commands', title: 'Commands', titleKey: 'settings.page.commands.title', group: 'pi', kind: 'single', icon: 'command', order: 43, keywords: ['pi', 'command', 'commands', 'slash command', 'extension command', 'prompt command', 'skill command'] }, { renderContent: () => <CommandsPage /> }),
  page({ slug: 'prompts', title: 'Prompts', titleKey: 'settings.page.prompts.title', group: 'pi', kind: 'split', icon: 'file-text', order: 44, keywords: ['pi', 'prompt', 'prompts', 'template', 'templates', 'markdown', '.md', 'argument hint'] }, { renderContent: () => <PromptsPage />, renderSidebar: (options) => <PromptsSidebar onItemSelect={options.onItemSelect} /> }),
  page({ slug: 'skills', title: 'Skills', titleKey: 'settings.page.skills.title', group: 'pi', kind: 'split', icon: 'sparkling', order: 45, keywords: ['pi', 'skill', 'skills', 'skill.md', 'markdown', 'package resource'] }, { renderContent: () => <SkillsPage />, renderSidebar: (options) => <SkillsSidebar onItemSelect={options.onItemSelect} /> }),
  page({ slug: 'plugins', title: 'Pi Packages', titleKey: 'settings.page.plugins.title', group: 'pi', kind: 'single', icon: 'plug-2', order: 47, keywords: ['pi', 'package', 'packages', 'plugin', 'plugins', 'extensions', 'npm', 'git', 'local path'] }, { renderContent: () => <PluginsPage /> }),
  page({ slug: 'extensions', title: 'Piarium Extensions', titleKey: 'settings.page.extensions.title', group: 'pi', kind: 'single', icon: 'plug-2', order: 49, keywords: ['piarium', 'extension', 'extensions', 'enable', 'disable', 'capabilities'] }, { renderContent: () => <ExtensionsPage /> }),
  page({ slug: 'magic-prompts', title: 'Magic Prompts', titleKey: 'settings.page.magicPrompts.title', group: 'content', kind: 'split', icon: 'ai-generate-2', order: 60, keywords: ['prompts', 'templates', 'git', 'github', 'review', 'commit', 'pull request'] }, { isAvailable: notVSCode, renderContent: () => <MagicPromptsPage />, renderSidebar: (options) => <MagicPromptsSidebar onItemSelect={options.onItemSelect} /> }),
  page({ slug: 'snippets', title: 'Snippets', titleKey: 'settings.page.snippets.title', group: 'content', kind: 'split', icon: 'chat-thread', order: 61, keywords: ['prompt', 'templates', 'multi-run', 'strategy', 'approach'] }, { renderContent: () => <SnippetsPage />, renderSidebar: (options) => <SnippetsSidebar onItemSelect={options.onItemSelect} /> }),
];

export const registerBuiltinSettingsContributions = (context: SurfaceActivationContext): void => {
  for (const definition of BUILTIN_SETTINGS_PAGES) {
    context.contribute({
      id: `${BUILTIN_SETTINGS_EXTENSION_ID}.page.${definition.meta.slug}`,
      kind: 'settings-page',
      contractVersion: 1,
      supports: ['web', 'desktop', 'mobile', 'vscode'],
      placement: { slot: `settings.nav.${definition.meta.group}`, order: definition.meta.order },
      data: {
        slug: definition.meta.slug,
        title: definition.meta.title,
        titleKey: definition.meta.titleKey,
        group: definition.meta.group,
        kind: definition.meta.kind,
        icon: definition.meta.icon,
        order: definition.meta.order,
        ...(definition.meta.badgeKey ? { badgeKey: definition.meta.badgeKey } : {}),
        keywords: definition.meta.keywords ?? [],
      },
    }, definition.implementation);
  }
};
