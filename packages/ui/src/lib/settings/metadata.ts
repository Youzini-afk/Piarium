import type { IconName } from '@/components/icon/icons';

export type SettingsPageSlug =
  | 'home'
  | 'general'
  | 'projects'
  | 'remote-instances'
  | 'providers'
  | 'agents'
  | 'fleet'
  | 'commands'
  | 'prompts'
  | 'skills'
  | 'usage'
  | 'mcp'
  | 'plugins'
  | 'plugin-settings'
  | 'git'
  | 'appearance'
  | 'chat'
  | 'shortcuts'
  | 'sessions'
  | 'magic-prompts'
  | 'snippets'
  | 'notifications'
  | 'voice'
  | 'tunnel'
  | 'about';

type SettingsPageGroup =
  | 'general'
  | 'projects'
  | 'pi'
  | 'content';

export interface SettingsRuntimeContext {
  isVSCode: boolean;
  isWeb: boolean;
  isDesktop: boolean;
  isMobile: boolean;
  mcpInstalled: boolean;
}

export interface SettingsPageMeta {
  slug: SettingsPageSlug;
  title: string;
  group: SettingsPageGroup;
  kind: 'single' | 'split';
  description?: string;
  keywords?: string[];
  primaryNav?: boolean;
  isAvailable?: (ctx: SettingsRuntimeContext) => boolean;
}

export const SETTINGS_PAGE_METADATA: readonly SettingsPageMeta[] = [
  {
    slug: 'home',
    title: 'Settings',
    group: 'general',
    kind: 'single',
    description: 'Search and jump to common pages.',
    keywords: ['search', 'settings'],
  },
  {
    slug: 'general',
    title: 'General',
    group: 'general',
    kind: 'single',
    keywords: ['general', 'startup', 'launch at login', 'autostart', 'tray', 'password', 'passkey', 'security', 'privacy', 'telemetry', 'transport', 'network', 'lan'],
  },
  {
    slug: 'projects',
    title: 'Projects',
    group: 'projects',
    kind: 'split',
    keywords: ['project', 'projects', 'worktree', 'worktrees', 'repo', 'repository', 'directory'],
  },
  {
    slug: 'remote-instances',
    title: 'Remote Instances',
    group: 'projects',
    kind: 'single',
    keywords: ['ssh', 'remote', 'instances', 'tunnels', 'forwarding', 'connection'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'providers',
    title: 'Providers',
    group: 'pi',
    kind: 'split',
    keywords: ['provider', 'providers', 'models', 'model', 'api key', 'api keys', 'openai', 'anthropic', 'ollama', 'credentials'],
  },
  {
    slug: 'agents',
    title: 'Agents',
    group: 'pi',
    kind: 'split',
    keywords: ['agent', 'agents', 'subagent', 'subagents', 'roles', 'workflow', 'pi-subagents', 'magic context', 'historian', 'dreamer', 'sidekick'],
  },
  {
    slug: 'fleet',
    title: 'Fleet',
    group: 'pi',
    kind: 'single',
    keywords: ['fleet', 'subagent', 'subagents', 'delegation', 'tasks', 'running', 'pi-subagents'],
  },
  {
    slug: 'commands',
    title: 'Commands',
    group: 'pi',
    kind: 'single',
    keywords: ['pi', 'command', 'commands', 'slash command', 'extension command', 'prompt command', 'skill command'],
  },
  {
    slug: 'prompts',
    title: 'Prompts',
    group: 'pi',
    kind: 'split',
    keywords: ['pi', 'prompt', 'prompts', 'template', 'templates', 'markdown', '.md', 'argument hint'],
  },
  {
    slug: 'skills',
    title: 'Skills',
    group: 'pi',
    kind: 'split',
    keywords: ['pi', 'skill', 'skills', 'skill.md', 'markdown', 'package resource'],
  },
  {
    slug: 'usage',
    title: 'Usage',
    group: 'general',
    kind: 'split',
    keywords: ['quota', 'billing', 'tokens', 'usage', 'limits'],
  },
  {
    slug: 'mcp',
    title: 'MCP',
    group: 'pi',
    kind: 'split',
    keywords: ['mcp', 'model context protocol', 'pi-mcp-adapter', 'servers', 'tools', 'resources', 'oauth', 'remote', 'stdio'],
    isAvailable: (ctx) => ctx.mcpInstalled,
  },
  {
    slug: 'plugins',
    title: 'Pi Packages',
    group: 'pi',
    kind: 'single',
    keywords: ['pi', 'package', 'packages', 'plugin', 'plugins', 'extensions', 'npm', 'git', 'local path'],
  },
  {
    slug: 'plugin-settings',
    title: 'Plugin Settings',
    group: 'pi',
    kind: 'split',
    keywords: ['pi', 'plugin', 'settings', 'configuration', 'subagents', 'magic context', 'web access', 'workspace history', 'wtf'],
  },
  {
    slug: 'git',
    title: 'Git',
    group: 'projects',
    kind: 'single',
    keywords: ['git', 'github', 'identity', 'identities', 'ssh', 'profiles', 'credentials', 'keys', 'commit', 'gitmoji', 'oauth', 'prs', 'issues'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'appearance',
    title: 'Appearance',
    group: 'general',
    kind: 'single',
    keywords: ['theme', 'font', 'spacing', 'padding', 'corner radius', 'radius', 'input bar', 'keyboard', 'viewport', 'mobile', 'terminal', 'pwa', 'install name', 'app shortcuts'],
  },
  {
    slug: 'chat',
    title: 'Chat',
    group: 'general',
    kind: 'single',
    keywords: ['tools', 'diff', 'reasoning', 'dotfiles', 'draft', 'queue', 'output', 'copy', 'image', 'split messages', 'message actions'],
  },
  {
    slug: 'shortcuts',
    title: 'Shortcuts',
    group: 'general',
    kind: 'single',
    keywords: ['keyboard', 'hotkeys', 'shortcuts', 'bindings'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'sessions',
    title: 'Sessions',
    group: 'general',
    kind: 'single',
    keywords: ['defaults', 'default agent', 'default model', 'retention', 'memory', 'zen', 'recovery', 'rollback', 'undo', 'checkpoint', 'pi-workspace-history', 'pi-wtf'],
  },
  {
    slug: 'magic-prompts',
    title: 'Magic Prompts',
    group: 'content',
    kind: 'split',
    keywords: ['prompts', 'templates', 'git', 'github', 'review', 'commit', 'pull request'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'snippets',
    title: 'Snippets',
    group: 'content',
    kind: 'split',
    keywords: ['prompt', 'templates', 'multi-run', 'strategy', 'approach'],
  },

  { slug: 'notifications', title: 'Notifications', group: 'general', kind: 'single', keywords: ['alerts', 'native', 'summary', 'summarization'], },
  { slug: 'voice', title: 'Voice', group: 'general', kind: 'single', keywords: ['tts', 'speech', 'voice'], isAvailable: (ctx) => !ctx.isVSCode },
  { slug: 'tunnel', title: 'External Tunnel', group: 'projects', kind: 'single', keywords: ['tunnel', 'external', 'cloudflare', 'qr', 'remote', 'mobile', 'share'], isAvailable: (ctx) => !ctx.isVSCode },
  { slug: 'about', title: 'About', group: 'general', kind: 'single', keywords: ['about', 'version', 'updates', 'release', 'changelog'], isAvailable: (ctx) => ctx.isMobile && !ctx.isVSCode },
] as const;

export function getSettingsPageMeta(slug: string): SettingsPageMeta | null {
  const normalized = slug.trim().toLowerCase();
  return (SETTINGS_PAGE_METADATA as readonly SettingsPageMeta[]).find((page) => page.slug === normalized) ?? null;
}

export function resolveSettingsSlug(value: string | null | undefined): SettingsPageSlug {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) {
    return 'home';
  }

  const direct = getSettingsPageMeta(normalized);
  if (direct) {
    return direct.slug;
  }

  return 'home';
}

// Keep this lightweight metadata beside the page registry. Consumers such as
// the command palette should not have to import the entire settings surface
// merely to render a navigation icon.
export function getSettingsNavIcon(slug: SettingsPageSlug): IconName | null {
  switch (slug) {
    case 'general':
      return 'settings-3';
    case 'projects':
      return 'folders';
    case 'remote-instances':
      return 'computer';
    case 'appearance':
      return 'palette';
    case 'chat':
      return 'chat-ai-3';
    case 'magic-prompts':
      return 'ai-generate-2';
    case 'snippets':
      return 'chat-thread';
    case 'notifications':
      return 'notification-3';
    case 'shortcuts':
      return 'command';
    case 'sessions':
      return 'chat-history';
    case 'providers':
      return 'cloud';
    case 'agents':
      return 'robot-2';
    case 'fleet':
      return 'pulse';
    case 'commands':
      return 'command';
    case 'prompts':
      return 'file-text';
    case 'skills':
      return 'sparkling';
    case 'mcp':
      return null;
    case 'plugins':
      return 'plug-2';
    case 'plugin-settings':
      return 'settings-3';
    case 'git':
      return 'git-branch';
    case 'usage':
      return 'bar-chart-2';
    case 'voice':
      return 'mic';
    case 'tunnel':
      return 'home-office';
    case 'about':
      return 'information';
    case 'home':
      return null;
    default:
      return 'robot-2';
  }
}
