import type { I18nKey } from '@/lib/i18n/store';
import type { SettingsPageSlug, SettingsRuntimeContext } from './metadata';
import { getSettingsPageMeta, getSettingsPageMetadata } from './metadata';

interface SettingsSearchItem {
  id: string;
  page: SettingsPageSlug;
  titleKey: I18nKey;
  descriptionKey?: I18nKey;
  keywords?: string[];
  isAvailable?: (ctx: SettingsSearchAvailabilityContext) => boolean;
}

export interface SettingsSearchResult extends SettingsSearchItem {
  title: string;
  description: string | null;
  pageTitle: string;
  focusTargetId?: string | null;
}

export interface SettingsSearchAvailabilityContext extends SettingsRuntimeContext {
  isMobile: boolean;
  isDesktopLocalOrigin: boolean;
  // macOS desktop shell — for controls that only render on darwin (e.g. dock badge).
  isMac: boolean;
  // Windows desktop shell — for controls that only render on win32.
  isWindows: boolean;
  // Linux desktop shell — for controls that only render on linux.
  isLinux: boolean;
}

const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'appearance.language',
    page: 'appearance',
    titleKey: 'settings.appearance.language.label',
    descriptionKey: 'settings.appearance.language.description',
    keywords: ['locale', 'translation', 'ui language'],
  },
  {
    id: 'appearance.time-format',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.timeFormat',
    keywords: ['clock', '12h', '24h'],
  },
  {
    id: 'appearance.week-start',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.weekStartsOn',
    keywords: ['calendar', 'monday', 'sunday'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.light-theme',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.lightTheme',
    keywords: ['theme', 'color', 'light mode'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.dark-theme',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.darkTheme',
    keywords: ['theme', 'color', 'dark mode'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.window-transparency',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.macVibrancy',
    descriptionKey: 'settings.piarium.visual.field.macVibrancyHint',
    keywords: ['transparent', 'transparency', 'vibrancy', 'blur', 'macos', 'opaque'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'appearance.dock-badge',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.dockBadge',
    descriptionKey: 'settings.piarium.visual.field.dockBadgeHint',
    keywords: ['dock', 'badge', 'unread', 'unseen', 'counter', 'count', 'notification', 'macos'],
    // Exactly matches the render guard in PiariumVisualSettings: any darwin
    // Electron shell (isMac already implies isDesktopShell), local or remote host.
    isAvailable: (ctx) => ctx.isMac,
  },
  {
    id: 'appearance.pwa-install-name',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.installAppName',
    descriptionKey: 'settings.piarium.visual.field.installAppNameHint',
    keywords: ['pwa', 'installed app'],
    isAvailable: (ctx) => ctx.isWeb && !ctx.isDesktop && !ctx.isVSCode,
  },
  {
    id: 'appearance.pwa-orientation',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.installOrientation',
    descriptionKey: 'settings.piarium.visual.field.installOrientationHint',
    keywords: ['pwa', 'portrait', 'landscape'],
    isAvailable: (ctx) => ctx.isWeb && !ctx.isDesktop && !ctx.isVSCode,
  },
  {
    id: 'appearance.mobile-keyboard-mode',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.mobileKeyboardMode',
    descriptionKey: 'settings.piarium.visual.field.mobileKeyboardModeHint',
    keywords: ['mobile', 'keyboard', 'resize'],
    isAvailable: (ctx) => ctx.isMobile && ctx.isWeb && !ctx.isDesktop && !ctx.isVSCode,
  },
  {
    id: 'appearance.interface-font-size',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.interfaceFontSize',
    keywords: ['font', 'text size', 'ui scale'],
    isAvailable: (ctx) => !ctx.isMobile,
  },
  {
    id: 'appearance.terminal-font-size',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.terminalFontSize',
    keywords: ['terminal', 'font', 'text size'],
  },
  {
    id: 'appearance.terminal-shell',
    page: 'general',
    titleKey: 'settings.piarium.visual.field.terminalShell',
    descriptionKey: 'settings.piarium.visual.field.terminalShellHint',
    keywords: ['terminal', 'shell', 'bash', 'zsh', 'fish', 'pwsh', 'powershell'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.editor-font-size',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.editorFontSize',
    keywords: ['editor', 'font', 'text size', 'code'],
  },
  {
    id: 'appearance.spacing-density',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.spacingDensity',
    keywords: ['density', 'compact', 'comfortable', 'spacing'],
  },
  {
    id: 'appearance.input-bar-offset',
    page: 'appearance',
    titleKey: 'settings.piarium.visual.field.inputBarOffset',
    descriptionKey: 'settings.piarium.visual.field.inputBarOffsetTooltip',
    keywords: ['input', 'home bar', 'offset'],
    // Only the mobile composer applies this offset (ChatInput gates on isMobile).
    isAvailable: (ctx) => ctx.isMobile,
  },
  {
    id: 'appearance.auto-save-enabled',
    page: 'general',
    titleKey: 'settings.piarium.visual.field.autoSaveEnabled',
    descriptionKey: 'settings.piarium.visual.field.autoSaveEnabledInfo',
    keywords: ['editor', 'autosave', 'auto-save', 'files', 'save'],
  },
  {
    id: 'appearance.expanded-editor-toolbar',
    page: 'general',
    titleKey: 'settings.piarium.visual.field.expandedEditorToolbar',
    keywords: ['editor', 'toolbar', 'tabs', 'docked', 'files'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.file-editor-keymap',
    page: 'general',
    titleKey: 'settings.piarium.visual.field.fileEditorKeymap',
    keywords: ['editor', 'vim', 'keymap'],
  },
  {
    id: 'appearance.file-editor',
    page: 'general',
    titleKey: 'settings.piarium.editor.section.title',
    descriptionKey: 'settings.piarium.editor.section.description',
    keywords: ['editor', 'minimap', 'wrap', 'whitespace', 'indentation', 'format'],
  },
  {
    id: 'appearance.terminal-quick-keys',
    page: 'general',
    titleKey: 'settings.piarium.visual.field.terminalQuickKeys',
    descriptionKey: 'settings.piarium.visual.field.terminalQuickKeysTooltip',
    keywords: ['terminal', 'keyboard', 'esc', 'ctrl', 'arrows'],
    isAvailable: (ctx) => !ctx.isMobile && !ctx.isVSCode,
  },
  {
    id: 'chat.render-mode',
    page: 'chat',
    titleKey: 'settings.piarium.visual.section.chatRenderMode',
    keywords: ['messages', 'conversation', 'rendering'],
  },
  {
    id: 'chat.message-transport',
    page: 'general',
    titleKey: 'settings.piarium.visual.section.messageStreamTransport',
    keywords: ['streaming', 'sse', 'websocket'],
  },
  {
    id: 'chat.session-recap',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.sessionRecap',
    keywords: ['recap', 'assist', 'small model', 'summary'],
  },
  {
    id: 'chat.session-assistance',
    page: 'chat',
    titleKey: 'settings.piarium.visual.section.sessionAssistance',
    keywords: ['recap', 'suggestion', 'subagent'],
  },
  {
    id: 'chat.session-suggestion',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.sessionSuggestion',
    keywords: ['suggestion', 'assist', 'small model', 'follow up'],
  },
  {
    id: 'chat.session-goal',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.sessionGoal',
    keywords: ['goal', 'objective', 'auto continue', 'small model'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'chat.session-goal-budget',
    page: 'chat',
    titleKey: 'settings.piarium.visual.goal.budgetLabel',
    keywords: ['goal', 'budget', 'tokens', 'limit'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'chat.reasoning-traces',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.showReasoningTraces',
    keywords: ['thinking', 'reasoning'],
  },
  {
    id: 'chat.reasoning',
    page: 'chat',
    titleKey: 'settings.piarium.visual.section.reasoning',
    keywords: ['thinking', 'traces'],
  },
  {
    id: 'chat.sticky-user-header',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.stickyUserHeader',
    keywords: ['messages', 'header'],
  },
  {
    id: 'chat.prompt-navigator',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.promptNavigatorEnabled',
    keywords: ['prompt', 'navigator', 'navigation', 'timeline', 'scroll'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'chat.collapsible-user-messages',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.collapsibleUserMessages',
    keywords: ['collapse', 'expand', 'clamp', 'long messages', 'user messages'],
  },
  {
    id: 'chat.wide-layout',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.wideChatLayout',
    keywords: ['layout', 'wide', 'messages'],
  },
  {
    id: 'chat.message-appearance',
    page: 'chat',
    titleKey: 'settings.piarium.visual.section.messageAppearance',
    keywords: ['layout', 'messages', 'appearance'],
  },
  {
    id: 'chat.code-block-line-wrap',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.codeBlockLineWrap',
    keywords: ['code', 'wrap', 'line wrap', 'markdown'],
  },
  {
    id: 'chat.inline-assistant-actions',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.showSplitAssistantMessageActions',
    descriptionKey: 'settings.piarium.visual.field.showSplitAssistantMessageActionsTooltip',
    keywords: ['copy', 'save image', 'read aloud'],
  },
  {
    id: 'chat.draft-starters-visible',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.draftStartersVisible',
    keywords: ['starter', 'starters', 'new session', 'welcome', 'suggestions'],
  },
  {
    id: 'chat.subagent-read-only-banner',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.allowPromptingSubagentSessions',
    keywords: ['subagent', 'read only', 'prompt', 'banner'],
  },
  {
    id: 'chat.tool-file-icons',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.showToolFileIcons',
    keywords: ['tools', 'files', 'icons'],
  },
  {
    id: 'chat.tools-and-files',
    page: 'chat',
    titleKey: 'settings.piarium.visual.section.toolsAndFiles',
    keywords: ['tools', 'files', 'dotfiles'],
  },
  {
    id: 'chat.changed-files',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.showTurnChangedFiles',
    keywords: ['changed files', 'turns'],
  },
  {
    id: 'chat.server-permission-auto-accept',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.serverPermissionAutoAccept',
    descriptionKey: 'settings.piarium.visual.field.serverPermissionAutoAcceptTooltip',
    keywords: ['permission', 'permissions', 'auto accept', 'approve', 'unattended', 'backend'],
  },
  {
    id: 'chat.dotfiles',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.showDotfiles',
    keywords: ['hidden files'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'chat.follow-up-behavior',
    page: 'chat',
    titleKey: 'settings.piarium.visual.section.followUpBehavior',
    descriptionKey: 'settings.piarium.visual.field.followUpBehaviorDescription',
    keywords: ['follow up', 'queue', 'steer', 'send immediately'],
  },
  {
    id: 'chat.persist-drafts',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.persistDraftMessages',
    keywords: ['draft', 'message'],
  },
  {
    id: 'chat.composer',
    page: 'chat',
    titleKey: 'settings.piarium.visual.section.composer',
    keywords: ['input', 'draft', 'spellcheck'],
  },
  {
    id: 'chat.spellcheck',
    page: 'chat',
    titleKey: 'settings.piarium.visual.field.enableSpellcheckInTextInputs',
    keywords: ['spelling', 'input'],
    isAvailable: (ctx) => !ctx.isMobile,
  },
  {
    id: 'sessions.default-model',
    page: 'sessions',
    titleKey: 'settings.piarium.defaults.field.defaultModel',
    keywords: ['model', 'provider', 'new sessions'],
  },
  {
    id: 'sessions.default-thinking',
    page: 'sessions',
    titleKey: 'settings.piarium.defaults.field.defaultThinking',
    keywords: ['thinking', 'reasoning', 'variant'],
  },
  {
    id: 'sessions.deletion-dialog',
    page: 'sessions',
    titleKey: 'settings.piarium.defaults.field.showDeletionDialog',
    keywords: ['delete', 'confirmation'],
  },
  {
    id: 'sessions.small-model',
    page: 'sessions',
    titleKey: 'settings.piarium.defaults.smallModel.title',
    descriptionKey: 'settings.piarium.defaults.smallModel.description',
    keywords: ['small model', 'utility', 'summary', 'recap', 'cheap', 'override'],
  },
  {
    id: 'sessions.walkthrough-model',
    page: 'sessions',
    titleKey: 'settings.piarium.defaults.walkthroughModel.title',
    descriptionKey: 'settings.piarium.defaults.walkthroughModel.description',
    keywords: ['walkthrough', 'review', 'diff', 'model'],
  },
  {
    id: 'sessions.auto-cleanup',
    page: 'sessions',
    titleKey: 'settings.piarium.sessionRetention.field.enableAutoCleanup',
    descriptionKey: 'settings.piarium.sessionRetention.tooltip',
    keywords: ['retention', 'archive', 'delete'],
  },
  {
    id: 'sessions.retention-period',
    page: 'sessions',
    titleKey: 'settings.piarium.sessionRetention.field.retentionPeriod',
    keywords: ['days', 'cleanup', 'retention'],
  },
  {
    id: 'sessions.retention-action',
    page: 'sessions',
    titleKey: 'settings.piarium.sessionRetention.field.whenSessionsExpire',
    keywords: ['archive', 'delete', 'expire'],
  },
  {
    id: 'sessions.desktop-launch-at-login',
    page: 'general',
    titleKey: 'settings.piarium.desktopNetwork.field.launchAtLogin',
    descriptionKey: 'settings.piarium.desktopNetwork.field.launchAtLoginDescription',
    keywords: ['desktop', 'startup', 'login', 'launch', 'background', 'autostart'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'sessions.desktop-window-controls-position',
    page: 'appearance',
    titleKey: 'settings.piarium.desktopNetwork.field.windowControlsPosition',
    descriptionKey: 'settings.piarium.desktopNetwork.field.windowControlsPositionDescription',
    keywords: ['desktop', 'window', 'controls', 'minimize', 'maximize', 'close', 'titlebar', 'linux', 'windows'],
    isAvailable: (ctx) => ctx.isDesktop && (ctx.isWindows || !ctx.isMac),
  },
  {
    id: 'sessions.desktop-window-controls-style',
    page: 'appearance',
    titleKey: 'settings.piarium.desktopNetwork.field.windowControlsStyle',
    keywords: ['desktop', 'window', 'controls', 'style', 'traffic', 'lights', 'classic', 'macos', 'titlebar'],
    isAvailable: (ctx) => ctx.isDesktop && (ctx.isWindows || !ctx.isMac),
  },
  {
    id: 'sessions.desktop-mac-menu-bar',
    page: 'general',
    titleKey: 'settings.piarium.desktopNetwork.field.macMenuBar',
    descriptionKey: 'settings.piarium.desktopNetwork.field.macMenuBarDescription',
    keywords: ['desktop', 'menu bar', 'tray', 'status item', 'macos', 'background'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin && ctx.isMac,
  },
  {
    id: 'sessions.desktop-minimize-to-tray',
    page: 'general',
    titleKey: 'settings.piarium.desktopNetwork.field.minimizeToTray',
    descriptionKey: 'settings.piarium.desktopNetwork.field.minimizeToTrayDescription',
    keywords: ['desktop', 'tray', 'system tray', 'minimize', 'close', 'background', 'windows', 'linux'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin && (ctx.isWindows || ctx.isLinux),
  },
  {
    id: 'sessions.desktop-keep-awake',
    page: 'general',
    titleKey: 'settings.piarium.desktopNetwork.field.keepAwake',
    descriptionKey: 'settings.piarium.desktopNetwork.field.keepAwakeDescription',
    keywords: ['desktop', 'sleep', 'awake', 'server', 'mobile', 'phone'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'sessions.desktop-ui-password',
    page: 'general',
    titleKey: 'settings.piarium.desktopPassword.field.password',
    descriptionKey: 'settings.piarium.desktopPassword.field.passwordDescription',
    keywords: ['desktop', 'password', 'auth', 'login'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'sessions.desktop-lan-access',
    page: 'general',
    titleKey: 'settings.piarium.desktopNetwork.field.allowLanAccess',
    descriptionKey: 'settings.piarium.desktopNetwork.field.allowLanAccessDescription',
    keywords: ['desktop', 'lan', 'network', 'phone', 'tablet'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'git.github-account',
    page: 'git',
    titleKey: 'settings.github.page.actions.connect',
    keywords: ['github', 'account', 'oauth', 'prs', 'issues'],
  },
  {
    id: 'git.identities',
    page: 'git',
    titleKey: 'settings.gitIdentities.page.section.title',
    descriptionKey: 'settings.gitIdentities.page.empty.description',
    keywords: ['identity', 'profile', 'author', 'email', 'credentials', 'signing', 'commit signing', 'ssh signing', 'gpg'],
  },
  {
    id: 'git.changes-view',
    page: 'git',
    titleKey: 'settings.piarium.git.changesViewTitle',
    keywords: ['changes', 'flat list', 'tree view'],
  },
  {
    id: 'git.gitmoji',
    page: 'git',
    titleKey: 'settings.piarium.git.enableGitmoji',
    keywords: ['commit', 'emoji'],
  },
  {
    id: 'git.gitignored-files',
    page: 'git',
    titleKey: 'settings.piarium.git.showGitignored',
    keywords: ['ignored', 'files', 'gitignore'],
  },
  {
    id: 'usage.header-menu',
    page: 'usage',
    titleKey: 'settings.usage.page.options.showInHeader',
    descriptionKey: 'settings.usage.page.options.showInHeaderTooltip',
    keywords: ['quota', 'header', 'dropdown'],
  },
  {
    id: 'usage.model-quotas',
    page: 'usage',
    titleKey: 'settings.usage.page.section.modelQuotas',
    keywords: ['models', 'quota', 'limits', 'tokens'],
  },
  {
    id: 'projects.name',
    page: 'projects',
    titleKey: 'settings.projects.page.field.projectName',
    keywords: ['label', 'display name', 'project metadata'],
  },
  {
    id: 'projects.default-model',
    page: 'projects',
    titleKey: 'settings.projects.page.field.defaultModel',
    descriptionKey: 'settings.projects.page.field.defaultModelDescription',
    keywords: ['model', 'new chat', 'project default'],
  },
  {
    id: 'projects.accent-color',
    page: 'projects',
    titleKey: 'settings.projects.page.field.accentColor',
    keywords: ['color', 'appearance', 'project metadata'],
  },
  {
    id: 'projects.icon',
    page: 'projects',
    titleKey: 'settings.projects.page.field.projectIcon',
    keywords: ['icon', 'favicon', 'upload', 'project metadata'],
  },
  {
    id: 'projects.worktree',
    page: 'projects',
    titleKey: 'settings.projects.page.section.worktree',
    keywords: ['worktree', 'branch', 'repository'],
  },
  {
    id: 'projects.worktree.setup.wait',
    page: 'projects',
    titleKey: 'settings.piarium.worktrees.setup.waitForCommands',
    keywords: ['worktree', 'setup commands', 'bootstrap', 'wait'],
  },
  {
    id: 'projects.actions',
    page: 'projects',
    titleKey: 'settings.projects.actions.title',
    descriptionKey: 'settings.projects.actions.description',
    keywords: ['command', 'automation', 'open url', 'ssh forward'],
  },
  {
    id: 'remote-instances.client-auth',
    page: 'remote-instances',
    titleKey: 'settings.remoteInstances.clientAuth.title',
    descriptionKey: 'settings.remoteInstances.clientAuth.description',
    keywords: ['pairing link', 'client token', 'connect desktop', 'remote access', 'relay', 'devices', 'connect from anywhere'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'remote-instances.direct-hosts',
    page: 'remote-instances',
    titleKey: 'settings.remoteInstances.direct.title',
    descriptionKey: 'settings.remoteInstances.direct.description',
    keywords: ['server url', 'connection token', 'import link', 'host switcher', 'additional headers', 'request headers', 'cloudflare access', 'service token'],
    isAvailable: (ctx) => ctx.isDesktop,
  },
  {
    id: 'agents.providers',
    page: 'agents',
    titleKey: 'settings.piarium.agents.providers.title',
    descriptionKey: 'settings.piarium.agents.providers.description',
    keywords: ['provider', 'pi-subagents', 'magic context', 'historian', 'dreamer', 'sidekick'],
  },
  {
    id: 'fleet.provider',
    page: 'fleet',
    titleKey: 'settings.piarium.fleet.provider.title',
    descriptionKey: 'settings.piarium.fleet.provider.description',
    keywords: ['pi-subagents', 'pi-background-tasks', 'eventbus', 'provider', 'delegation'],
  },
  {
    id: 'fleet.list',
    page: 'fleet',
    titleKey: 'settings.piarium.fleet.list.title',
    descriptionKey: 'settings.piarium.fleet.description',
    keywords: ['background task', 'background agent', 'logs', 'kill', 'stop', 'run', 'jobs'],
  },
  {
    id: 'fleet.actions',
    page: 'fleet',
    titleKey: 'settings.piarium.fleet.actions.title',
    descriptionKey: 'settings.piarium.fleet.actions.description',
    keywords: ['inspector', 'doctor', 'subagents-stop', 'packages'],
  },
  {
    id: 'agents.catalog',
    page: 'agents',
    titleKey: 'settings.piarium.agents.catalog.title',
    descriptionKey: 'settings.piarium.agents.description',
    keywords: ['agent', 'subagent', 'workflow', 'role', 'model', 'fallback', 'thinking'],
  },
  {
    id: 'prompts.editor',
    page: 'prompts',
    titleKey: 'settings.piarium.prompts.catalog.title',
    descriptionKey: 'settings.piarium.prompts.description',
    keywords: ['prompt', 'template', 'markdown', 'argument hint', 'user', 'project', 'copy'],
  },
  {
    id: 'skills.editor',
    page: 'skills',
    titleKey: 'settings.piarium.skills.catalog.title',
    descriptionKey: 'settings.piarium.skills.description',
    keywords: ['skill', 'skill.md', 'markdown', 'user', 'project', 'package', 'copy'],
  },
  {
    id: 'mcp.runtime',
    page: 'mcp',
    titleKey: 'settings.piarium.mcp.runtime.title',
    keywords: ['server', 'status', 'reconnect', 'oauth', 'tools', 'resources'],
  },
  {
    id: 'mcp.configuration',
    page: 'mcp',
    titleKey: 'settings.piarium.mcp.config.title',
    keywords: ['json', 'jsonc', 'config', 'stdio', 'url', 'environment', 'headers', 'timeout'],
  },
  {
    id: 'plugins.packages',
    page: 'plugins',
    titleKey: 'settings.piarium.plugins.configured.title',
    descriptionKey: 'settings.piarium.plugins.configured.description',
    keywords: ['pi', 'packages', 'plugins', 'update', 'remove'],
  },
  {
    id: 'plugins.source',
    page: 'plugins',
    titleKey: 'settings.piarium.plugins.source.title',
    descriptionKey: 'settings.piarium.plugins.source.description',
    keywords: ['install', 'npm', 'git', 'url', 'local path', 'source'],
  },
  {
    id: 'plugins.recommended',
    page: 'plugins',
    titleKey: 'settings.piarium.plugins.recommended.title',
    descriptionKey: 'settings.piarium.plugins.recommended.description',
    keywords: ['subagents', 'magic context', 'mcp', 'web access', 'workspace history', 'wtf', 'background tasks', 'fleet'],
  },
  {
    id: 'extensions.workbench',
    page: 'extensions',
    titleKey: 'settings.piarium.extensions.workbench.title',
    keywords: ['profile', 'shell', 'layout', 'workbench', 'ide'],
  },
  {
    id: 'extensions.workbench.profile',
    page: 'extensions',
    titleKey: 'settings.piarium.extensions.workbench.profile',
    keywords: ['profile', 'agent', 'ide', 'layout'],
  },
  {
    id: 'extensions.workbench.shell',
    page: 'extensions',
    titleKey: 'settings.piarium.extensions.workbench.selectedShell',
    keywords: ['shell', 'recovery', 'enable', 'disable'],
  },
  {
    id: 'extensions.workbench.extensionSet',
    page: 'extensions',
    titleKey: 'settings.piarium.extensions.workbench.extensionSet',
    keywords: ['apply', 'enable', 'extensions', 'set'],
  },
  {
    id: 'plugin-settings.configuration',
    page: 'plugin-settings',
    titleKey: 'settings.piarium.pluginSettings.integrations.title',
    descriptionKey: 'settings.piarium.pluginSettings.description',
    keywords: [
      'json',
      'jsonc',
      'settings',
      'subagents',
      'agents',
      'workflows',
      'roles',
      'create agent',
      'model overrides',
      'fallback models',
      'thinking',
      'delegation',
      'review',
      'watchdog',
      'fleet',
      'worktree',
      'intercom',
      'budget',
      'scheduled runs',
      'magic context',
      'historian',
      'dreamer',
      'sidekick',
      'memory',
      'embedding',
      'synapse',
      'sqlite',
      'mural',
      'context compression',
      'aft',
      'cortexkit',
      'hashline',
      'semantic search',
      'cron',
      'web access',
      'web search',
      'curator',
      'search routing',
      'exa',
      'brave',
      'searxng',
      'firecrawl',
      'gemini web',
      'browser cookies',
      'ssrf',
      'domain policy',
      'openai codex compat',
      'responses lite',
      'remote compaction',
      'observational memory',
      'observations',
      'reflections',
      'observation pool',
      'pi-lens',
      'lint',
      'lsp diagnostics',
      'read guard',
      'opengrep',
      'trivy',
      'helm render',
      'technical debt',
      'permission system',
      'permissions',
      'allow ask deny',
      'yolo mode',
      'permission review log',
      'hermes memory',
      'persistent memory',
      'memory insights',
      'memory policy',
      'memory review',
      'session search',
      'rtk',
      'rtk optimizer',
      'command rewrite',
      'output compaction',
      'smart truncation',
    ],
  },
  {
    id: 'snippets.create',
    page: 'snippets',
    titleKey: 'settings.snippets.sidebar.actions.create',
    keywords: ['add', 'new snippet'],
  },
  {
    id: 'snippets.content',
    page: 'snippets',
    titleKey: 'settings.snippets.page.field.content',
    keywords: ['markdown', 'prompt', 'template'],
  },
  {
    id: 'runtime.current',
    page: 'runtime',
    titleKey: 'settings.runtime.section.current',
    descriptionKey: 'settings.page.runtime.description',
    keywords: ['pi', 'runtime', 'version', 'path', 'node'],
  },
  {
    id: 'runtime.status',
    page: 'runtime',
    titleKey: 'settings.runtime.field.status',
    keywords: ['ready', 'missing', 'upgrade', 'failed'],
  },
  {
    id: 'runtime.version',
    page: 'runtime',
    titleKey: 'settings.runtime.field.version',
    keywords: ['pi version', 'sdk'],
  },
  {
    id: 'runtime.commandPath',
    page: 'runtime',
    titleKey: 'settings.runtime.field.commandPath',
    keywords: ['path', 'executable', 'pi.cmd'],
  },
  {
    id: 'runtime.packageRoot',
    page: 'runtime',
    titleKey: 'settings.runtime.field.packageRoot',
    keywords: ['package', 'module', 'node_modules'],
  },
  {
    id: 'runtime.actions',
    page: 'runtime',
    titleKey: 'settings.runtime.section.actions',
    keywords: ['install', 'upgrade', 'rediscover', 'detect', 'choose'],
  },
  {
    id: 'providers.connect',
    page: 'providers',
    titleKey: 'settings.providers.page.connect.title',
    keywords: ['add provider', 'connect provider', 'custom provider', 'openai compatible', 'base url', 'credentials'],
  },
  {
    id: 'providers.auth',
    page: 'providers',
    titleKey: 'settings.providers.page.auth.title',
    keywords: ['api key', 'oauth', 'credentials'],
  },
  {
    id: 'providers.connection-details',
    page: 'providers',
    titleKey: 'settings.providers.page.connectionDetails.title',
    keywords: ['config', 'source', 'disconnect'],
  },
  {
    id: 'providers.models',
    page: 'providers',
    titleKey: 'settings.providers.page.models.title',
    keywords: ['models', 'hide', 'show'],
  },
  {
    id: 'magic-prompts.visible-prompt',
    page: 'magic-prompts',
    titleKey: 'settings.magicPrompts.page.block.visiblePrompt',
    keywords: ['prompt text', 'user message', 'template'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'magic-prompts.instructions',
    page: 'magic-prompts',
    titleKey: 'settings.magicPrompts.page.block.instructions',
    keywords: ['hidden prompt', 'instructions', 'template'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'magic-prompts.reset-overrides',
    page: 'magic-prompts',
    titleKey: 'settings.magicPrompts.page.actions.resetAllOverrides',
    keywords: ['reset', 'default prompts', 'overrides'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'shortcuts.keyboard-shortcuts',
    page: 'shortcuts',
    titleKey: 'settings.piarium.keyboardShortcuts.title',
    descriptionKey: 'settings.piarium.keyboardShortcuts.tooltip',
    keywords: ['keyboard', 'hotkeys', 'bindings'],
  },
  {
    id: 'voice.playback',
    page: 'voice',
    titleKey: 'settings.voice.page.section.playbackAndSummary',
    keywords: ['tts', 'read aloud', 'voice', 'provider', 'speech rate', 'speech pitch', 'speech volume', 'tts input mode', 'markdown'],
  },
  {
    id: 'voice.speech-recognition',
    page: 'voice',
    titleKey: 'settings.voice.page.section.speechRecognition',
    keywords: ['stt', 'dictation', 'voice input', 'transcribe', 'whisper', 'parakeet', 'microphone'],
  },
  {
    id: 'tunnel.provider',
    page: 'tunnel',
    titleKey: 'settings.piarium.tunnel.field.provider',
    descriptionKey: 'settings.piarium.tunnel.description',
    keywords: ['remote access', 'cloudflare', 'ngrok'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'tunnel.type',
    page: 'tunnel',
    titleKey: 'settings.piarium.tunnel.field.tunnelType',
    keywords: ['quick', 'managed remote', 'managed local'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'tunnel.ttl',
    page: 'tunnel',
    titleKey: 'settings.piarium.tunnel.field.connectLinkTtl',
    descriptionKey: 'settings.piarium.tunnel.field.tunnelSessionTtl',
    keywords: ['expiry', 'expiration', 'session ttl', 'connect link ttl'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'tunnel.managed-remote',
    page: 'tunnel',
    titleKey: 'settings.piarium.tunnel.section.savedManagedRemoteTunnels',
    keywords: ['cloudflare', 'hostname', 'token', 'managed remote'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'tunnel.managed-local-config',
    page: 'tunnel',
    titleKey: 'settings.piarium.tunnel.field.configurationFile',
    descriptionKey: 'settings.piarium.tunnel.note.managedLocalUsesConfig',
    keywords: ['cloudflared', 'config', 'yaml', 'json', 'managed local'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'tunnel.start',
    page: 'tunnel',
    titleKey: 'settings.piarium.tunnel.actions.startTunnel',
    descriptionKey: 'settings.piarium.tunnel.note.connectLinksOneTime',
    keywords: ['connect link', 'qr code', 'public url', 'remote access'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'notifications.delivery',
    page: 'notifications',
    titleKey: 'settings.notifications.page.delivery.title',
    keywords: ['desktop notifications', 'system notifications'],
  },
  {
    id: 'notifications.events',
    page: 'notifications',
    titleKey: 'settings.notifications.page.events.title',
    keywords: ['completion', 'subtasks', 'errors', 'questions'],
  },
  {
    id: 'notifications.push',
    page: 'notifications',
    titleKey: 'settings.notifications.page.push.title',
    keywords: ['background', 'push'],
    isAvailable: (ctx) => ctx.isWeb && !ctx.isDesktop && !ctx.isVSCode,
  },
] as const;

interface BuildSettingsSearchResultsOptions {
  query: string;
  runtimeCtx: SettingsSearchAvailabilityContext;
  visiblePageSlugs?: SettingsPageSlug[];
  t: (key: I18nKey) => string;
  getPageTitle: (slug: SettingsPageSlug) => string;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function buildSettingsSearchResults({
  query,
  runtimeCtx,
  visiblePageSlugs,
  t,
  getPageTitle,
}: BuildSettingsSearchResultsOptions): SettingsSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  const allowedPages = visiblePageSlugs ? new Set<SettingsPageSlug>(visiblePageSlugs) : null;
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);

  const pageResults = getSettingsPageMetadata().flatMap((page): SettingsSearchResult[] => {
    if (page.slug === 'home' || (allowedPages && !allowedPages.has(page.slug))) return [];
    if (page.isAvailable && !page.isAvailable(runtimeCtx)) return [];
    const title = getPageTitle(page.slug);
    const haystack = normalizeSearchText([
      title,
      page.title,
      page.group,
      ...(page.keywords ?? []),
    ].join(' '));
    if (!terms.every((term) => haystack.includes(term))) return [];
    return [{
      id: `settings-page:${page.slug}`,
      page: page.slug,
      titleKey: page.titleKey,
      keywords: page.keywords,
      title,
      description: null,
      pageTitle: title,
      focusTargetId: null,
    }];
  });

  const itemResults = SETTINGS_SEARCH_ITEMS.flatMap((item) => {
    if (allowedPages && !allowedPages.has(item.page)) {
      return [];
    }

    const pageMeta = getSettingsPageMeta(item.page);
    if (!pageMeta || (pageMeta.isAvailable && !pageMeta.isAvailable(runtimeCtx)) || (item.isAvailable && !item.isAvailable(runtimeCtx))) {
      return [];
    }

    const title = t(item.titleKey);
    const description = item.descriptionKey ? t(item.descriptionKey) : null;
    const haystack = normalizeSearchText([
      title,
      description,
      getPageTitle(item.page),
      ...(item.keywords ?? []),
    ].filter(Boolean).join(' '));

    if (!terms.every((term) => haystack.includes(term))) {
      return [];
    }

    return [{
      ...item,
      title,
      description,
      pageTitle: getPageTitle(item.page),
    }];
  });
  return [...pageResults, ...itemResults];
}
