import type { SettingsPageMeta, SettingsRuntimeContext } from './page-types';

export const BUILTIN_SETTINGS_EXTENSION_ID = 'piarium.builtin.settings';

export type BuiltinSettingsRenderer =
  | 'empty'
  | 'about'
  | 'commands'
  | 'extensions'
  | 'git'
  | 'magic-prompts'
  | 'plugins'
  | 'projects'
  | 'prompts'
  | 'providers'
  | 'remote-instances'
  | 'runtime'
  | 'skills'
  | 'snippets'
  | 'usage'
  | 'piarium:general'
  | 'piarium:visual'
  | 'piarium:chat'
  | 'piarium:notifications'
  | 'piarium:sessions'
  | 'piarium:shortcuts'
  | 'piarium:voice'
  | 'piarium:tunnel';

export interface BuiltinSettingsPageSpec {
  availability?: 'not-vscode' | 'not-vscode-or-mobile';
  meta: SettingsPageMeta;
  renderer: BuiltinSettingsRenderer;
}

const spec = (
  meta: SettingsPageMeta,
  renderer: BuiltinSettingsRenderer,
  availability?: BuiltinSettingsPageSpec['availability'],
): BuiltinSettingsPageSpec => ({ meta, renderer, ...(availability ? { availability } : {}) });

export const BUILTIN_SETTINGS_PAGE_SPECS: readonly BuiltinSettingsPageSpec[] = [
  spec({ slug: 'home', title: 'Settings', titleKey: 'settings.view.home.title', group: 'general', kind: 'single', icon: null, order: -1, keywords: ['search', 'settings'] }, 'empty'),
  spec({ slug: 'general', title: 'General', titleKey: 'settings.page.general.title', group: 'general', kind: 'single', icon: 'settings-3', order: 0, keywords: ['general', 'startup', 'launch at login', 'autostart', 'tray', 'password', 'passkey', 'security', 'transport', 'network', 'lan'] }, 'piarium:general'),
  spec({ slug: 'appearance', title: 'Appearance', titleKey: 'settings.page.appearance.title', group: 'general', kind: 'single', icon: 'palette', order: 1, keywords: ['theme', 'font', 'spacing', 'padding', 'corner radius', 'radius', 'input bar', 'keyboard', 'viewport', 'mobile', 'terminal', 'pwa', 'install name', 'app shortcuts'] }, 'piarium:visual'),
  spec({ slug: 'chat', title: 'Chat', titleKey: 'settings.page.chat.title', group: 'general', kind: 'single', icon: 'chat-ai-3', order: 2, keywords: ['tools', 'diff', 'reasoning', 'dotfiles', 'draft', 'queue', 'output', 'copy', 'image', 'split messages', 'message actions'] }, 'piarium:chat'),
  spec({ slug: 'notifications', title: 'Notifications', titleKey: 'settings.page.notifications.title', group: 'general', kind: 'single', icon: 'notification-3', order: 3, keywords: ['alerts', 'native', 'summary', 'summarization'] }, 'piarium:notifications'),
  spec({ slug: 'sessions', title: 'Sessions', titleKey: 'settings.page.sessions.title', group: 'general', kind: 'single', icon: 'chat-history', order: 4, keywords: ['defaults', 'default agent', 'default model', 'retention', 'memory', 'zen', 'recovery', 'rollback', 'undo', 'checkpoint', 'workspace snapshot'] }, 'piarium:sessions'),
  spec({ slug: 'shortcuts', title: 'Shortcuts', titleKey: 'settings.page.shortcuts.title', group: 'general', kind: 'single', icon: 'command', order: 5, keywords: ['keyboard', 'hotkeys', 'shortcuts', 'bindings'] }, 'piarium:shortcuts', 'not-vscode-or-mobile'),
  spec({ slug: 'voice', title: 'Voice', titleKey: 'settings.page.voice.title', group: 'general', kind: 'single', icon: 'mic', order: 6, keywords: ['tts', 'speech', 'voice'] }, 'piarium:voice', 'not-vscode'),
  spec({ slug: 'usage', title: 'Usage', titleKey: 'settings.page.usage.title', group: 'general', kind: 'split', icon: 'bar-chart-2', order: 7, keywords: ['quota', 'billing', 'tokens', 'usage', 'limits'] }, 'usage'),
  spec({ slug: 'about', title: 'About', titleKey: 'settings.page.about.title', group: 'general', kind: 'single', icon: 'information', order: 8, keywords: ['about', 'version', 'updates', 'release', 'changelog'] }, 'about', 'not-vscode'),
  spec({ slug: 'projects', title: 'Projects', titleKey: 'settings.page.projects.title', group: 'projects', kind: 'split', icon: 'folders', order: 20, keywords: ['project', 'projects', 'worktree', 'worktrees', 'repo', 'repository', 'directory'] }, 'projects', 'not-vscode'),
  spec({ slug: 'remote-instances', title: 'Remote Instances', titleKey: 'settings.page.remoteInstances.title', group: 'projects', kind: 'single', icon: 'computer', order: 21, keywords: ['ssh', 'remote', 'instances', 'tunnels', 'forwarding', 'connection'] }, 'remote-instances', 'not-vscode'),
  spec({ slug: 'tunnel', title: 'External Tunnel', titleKey: 'settings.page.tunnel.title', group: 'projects', kind: 'single', icon: 'home-office', order: 22, badgeKey: 'settings.view.badge.beta', keywords: ['tunnel', 'external', 'cloudflare', 'qr', 'remote', 'mobile', 'share'] }, 'piarium:tunnel', 'not-vscode'),
  spec({ slug: 'git', title: 'Git', titleKey: 'settings.page.git.title', group: 'projects', kind: 'single', icon: 'git-branch', order: 23, keywords: ['git', 'github', 'identity', 'identities', 'ssh', 'profiles', 'credentials', 'keys', 'commit', 'gitmoji', 'oauth', 'prs', 'issues'] }, 'git', 'not-vscode'),
  spec({ slug: 'runtime', title: 'Runtime', titleKey: 'settings.page.runtime.title', group: 'pi', kind: 'single', icon: 'terminal-box', order: 39, keywords: ['pi', 'runtime', 'install', 'upgrade', 'node', 'path', 'package root'] }, 'runtime'),
  spec({ slug: 'providers', title: 'Providers', titleKey: 'settings.page.providers.title', group: 'pi', kind: 'split', icon: 'cloud', order: 40, keywords: ['provider', 'providers', 'models', 'model', 'api key', 'api keys', 'openai', 'anthropic', 'ollama', 'credentials'] }, 'providers'),
  spec({ slug: 'commands', title: 'Commands', titleKey: 'settings.page.commands.title', group: 'pi', kind: 'single', icon: 'command', order: 43, keywords: ['pi', 'command', 'commands', 'slash command', 'extension command', 'prompt command', 'skill command'] }, 'commands'),
  spec({ slug: 'prompts', title: 'Prompts', titleKey: 'settings.page.prompts.title', group: 'pi', kind: 'split', icon: 'file-text', order: 44, keywords: ['pi', 'prompt', 'prompts', 'template', 'templates', 'markdown', '.md', 'argument hint'] }, 'prompts'),
  spec({ slug: 'skills', title: 'Skills', titleKey: 'settings.page.skills.title', group: 'pi', kind: 'split', icon: 'sparkling', order: 45, keywords: ['pi', 'skill', 'skills', 'skill.md', 'markdown', 'package resource'] }, 'skills'),
  spec({ slug: 'plugins', title: 'Pi Packages', titleKey: 'settings.page.plugins.title', group: 'pi', kind: 'single', icon: 'plug-2', order: 47, keywords: ['pi', 'package', 'packages', 'plugin', 'plugins', 'extensions', 'npm', 'git', 'local path'] }, 'plugins'),
  spec({ slug: 'extensions', title: 'Piarium Extensions', titleKey: 'settings.page.extensions.title', group: 'pi', kind: 'single', icon: 'plug-2', order: 49, keywords: ['piarium', 'extension', 'extensions', 'enable', 'disable', 'capabilities'] }, 'extensions'),
  spec({ slug: 'magic-prompts', title: 'Magic Prompts', titleKey: 'settings.page.magicPrompts.title', group: 'content', kind: 'split', icon: 'ai-generate-2', order: 60, keywords: ['prompts', 'templates', 'git', 'github', 'review', 'commit', 'pull request'] }, 'magic-prompts', 'not-vscode'),
  spec({ slug: 'snippets', title: 'Snippets', titleKey: 'settings.page.snippets.title', group: 'content', kind: 'split', icon: 'chat-thread', order: 61, keywords: ['prompt', 'templates', 'multi-run', 'strategy', 'approach'] }, 'snippets'),
];

export const isBuiltinSettingsPageAvailable = (
  spec: BuiltinSettingsPageSpec,
  context: SettingsRuntimeContext,
): boolean => spec.availability === 'not-vscode'
  ? !context.isVSCode
  : spec.availability === 'not-vscode-or-mobile'
    ? !context.isVSCode && !context.isMobile
    : true;
