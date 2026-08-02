import type { SidebarSection } from '@/constants/sidebar';

export type SettingsPageSlug =
  | 'home'
  | 'general'
  | 'projects'
  | 'remote-instances'
  | 'providers'
  | 'usage'
  | 'agents'
  | 'behavior'
  | 'commands'
  | 'mcp'
  | 'plugins'
  | 'skills.installed'
  | 'skills.catalog'
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
  | 'opencode'
  | 'content';

export interface SettingsRuntimeContext {
  isVSCode: boolean;
  isWeb: boolean;
  isDesktop: boolean;
  isMobile: boolean;
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
    keywords: ['general', 'startup', 'launch at login', 'autostart', 'tray', 'password', 'passkey', 'security', 'privacy', 'telemetry', 'transport', 'network', 'lan', 'binary', 'cli'],
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
    group: 'opencode',
    kind: 'split',
    keywords: ['provider', 'providers', 'models', 'model', 'api key', 'api keys', 'openai', 'anthropic', 'ollama', 'credentials'],
  },
  {
    slug: 'usage',
    title: 'Usage',
    group: 'general',
    kind: 'split',
    keywords: ['quota', 'billing', 'tokens', 'usage', 'limits'],
  },
  {
    slug: 'agents',
    title: 'Agents',
    group: 'opencode',
    kind: 'split',
    keywords: [
      'agent',
      'agents',
      'prompts',
      'tools',
      'permissions',
      'agent orchestration',
      'oh my openagent',
      'openagent',
      'oh-my-openagent',
      'oh-my-opencode-slim',
      'slim',
      'omo',
      'agent routing',
      'categories',
      'model routes',
    ],
  },
  {
    slug: 'behavior',
    title: 'Behavior',
    group: 'opencode',
    kind: 'single',
    keywords: ['behavior', 'agents.md', 'system prompt', 'global rules', 'instructions', 'override'],
  },
  {
    slug: 'commands',
    title: 'Commands',
    group: 'opencode',
    kind: 'split',
    keywords: ['command', 'commands', 'slash', 'macros', 'automation'],
  },
  {
    slug: 'mcp',
    title: 'MCP',
    group: 'opencode',
    kind: 'single',
    keywords: ['mcp', 'model context protocol', 'pi-mcp-adapter', 'servers', 'tools', 'resources', 'oauth', 'remote', 'stdio'],
  },
  {
    slug: 'plugins',
    title: 'Pi Packages',
    group: 'opencode',
    kind: 'single',
    keywords: ['pi', 'package', 'packages', 'plugin', 'plugins', 'extensions', 'npm', 'git', 'local path'],
  },
  {
    slug: 'skills.installed',
    title: 'Skills',
    group: 'content',
    kind: 'split',
    keywords: ['skill', 'skills', 'instructions', 'install', 'catalog'],
  },
  {
    slug: 'skills.catalog',
    title: 'Skills Catalog',
    group: 'content',
    kind: 'single',
    keywords: ['install', 'catalog', 'external', 'repository', 'skills catalog'],
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
    keywords: ['defaults', 'default agent', 'default model', 'retention', 'memory', 'limits', 'zen', 'recovery', 'rollback', 'undo', 'checkpoint', 'pi-workspace-history', 'pi-wtf'],
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

const LEGACY_SIDEBAR_SECTION_TO_SETTINGS_SLUG: Record<SidebarSection, SettingsPageSlug> = {
  sessions: 'sessions',
  agents: 'agents',
  commands: 'commands',
  mcp: 'mcp',
  skills: 'skills.installed',
  providers: 'providers',
  usage: 'usage',
  'git-identities': 'git',
  settings: 'home',
};

export function getSettingsPageMeta(slug: string): SettingsPageMeta | null {
  const normalized = slug.trim().toLowerCase();
  return (SETTINGS_PAGE_METADATA as readonly SettingsPageMeta[]).find((page) => page.slug === normalized) ?? null;
}

export function resolveSettingsSlug(value: string | null | undefined): SettingsPageSlug {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) {
    return 'home';
  }

  const legacy = (LEGACY_SIDEBAR_SECTION_TO_SETTINGS_SLUG as Record<string, SettingsPageSlug>)[normalized];
  if (legacy) {
    return legacy;
  }

  if (normalized === 'openagent' || normalized === 'agent-orchestration') {
    return 'agents';
  }

  if (normalized === 'magic-context') {
    return 'plugins';
  }

  const direct = getSettingsPageMeta(normalized);
  if (direct) {
    return direct.slug;
  }

  return 'home';
}
