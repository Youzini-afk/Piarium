import React from 'react';
import { PiariumVisualSettings } from './PiariumVisualSettings';
import { AboutSettings } from './AboutSettings';
import { SessionRetentionSettings } from './SessionRetentionSettings';
import { CheckpointSettings } from './CheckpointSettings';
import { PasskeySettings } from './PasskeySettings';
import { DefaultsSettings } from './DefaultsSettings';
import { GitSettings } from './GitSettings';
import { NotificationSettings } from './NotificationSettings';
import { GitHubSettings } from './GitHubSettings';
import { VoiceSettings } from './VoiceSettings';
import { TunnelSettings } from './TunnelSettings';
import { DesktopNetworkSettings } from './DesktopNetworkSettings';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { PiSettingsContributionSlot } from '@/lib/extensions/pi-integration-registry';
import type { PiariumSettingsSection } from './types';

const useRuntimeEndpointEpoch = (): number => {
    const [epoch, setEpoch] = React.useState(0);

    React.useEffect(() => {
        return subscribeRuntimeEndpointChanged(() => setEpoch((current) => current + 1));
    }, []);

    return epoch;
};

interface PiariumSettingsPageProps {
    /** Which section to display. If undefined, shows all sections (mobile/legacy behavior) */
    section?: PiariumSettingsSection;
}

export const PiariumSettingsPage: React.FC<PiariumSettingsPageProps> = ({ section }) => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
    const showAbout = isMobile && isWebRuntime();
    const isVSCode = isVSCodeRuntime();
    void runtimeEndpointEpoch;
    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();

    // If no section specified, show all (mobile/legacy behavior)
    if (!section) {
        return (
            <SettingsPageLayout showSaveStatus className="piarium-settings-page-body space-y-3 sm:space-y-6">
                <PiariumVisualSettings />
                <DefaultsSettings />
                {showDesktopNetworkSettings && <DesktopNetworkSettings />}
                <SessionRetentionSettings />
                <PiSettingsContributionSlot slot="settings.sessions.panels" />
                {isVSCode && <CheckpointSettings />}
                {isWebRuntime() && !isDesktopShell() && !isVSCode && !isCapacitorApp() && <PasskeySettings />}
                {showAbout && <AboutSettings />}
            </SettingsPageLayout>
        );
    }

    // Show specific section content
    const renderSectionContent = () => {
        switch (section) {
            case 'general':
                return <GeneralSectionContent />;
            case 'visual':
                return <VisualSectionContent />;
            case 'chat':
                return <ChatSectionContent />;
            case 'sessions':
                return <SessionsSectionContent />;
            case 'shortcuts':
                return <ShortcutsSectionContent />;
            case 'git':
                return <GitSectionContent />;
            case 'github':
                return <GitHubSectionContent />;
            case 'notifications':
                return <NotificationSectionContent />;
            case 'voice':
                return <VoiceSectionContent />;
            case 'tunnel':
                return <TunnelSectionContent />;
            case 'about':
                return <AboutSettings />;
            default:
                return null;
        }
    };

    const pageTitle = {
        general: t('settings.page.general.title'),
        visual: t('settings.page.appearance.title'),
        chat: t('settings.page.chat.title'),
        sessions: t('settings.page.sessions.title'),
        shortcuts: t('settings.page.shortcuts.title'),
        git: t('settings.page.git.title'),
        github: t('settings.page.git.title'),
        notifications: t('settings.page.notifications.title'),
        voice: t('settings.page.voice.title'),
        tunnel: t('settings.page.tunnel.title'),
        about: t('settings.page.about.title'),
    }[section];

    const pageDescription = {
        general: t('settings.page.general.description'),
        visual: t('settings.page.appearance.description'),
        chat: t('settings.page.chat.description'),
        sessions: t('settings.page.sessions.description'),
        shortcuts: t('settings.page.shortcuts.description'),
        git: undefined,
        github: undefined,
        notifications: t('settings.page.notifications.description'),
        voice: t('settings.page.voice.description'),
        tunnel: t('settings.page.tunnel.description'),
        about: undefined,
    }[section];

    return (
        <SettingsPageLayout
            title={pageTitle}
            description={pageDescription}
            showSaveStatus
            className="piarium-settings-page-body"
        >
            {renderSectionContent()}
        </SettingsPageLayout>
    );
};

const ShortcutsSectionContent: React.FC = () => {
    return <KeyboardShortcutsSettings />;
};

// General section: app-level settings — startup/tray/network, access password,
// passkeys, editor behavior, and privacy.
const GeneralSectionContent: React.FC = () => {
    const isVSCode = isVSCodeRuntime();
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
    void runtimeEndpointEpoch;
    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();
    // Passkeys only work against the browser's WebAuthn UI on the web surface —
    // desktop shell, VS Code, and the Capacitor app never show the login screen.
    const showPasskeySettings = isWebRuntime() && !isDesktopShell() && !isVSCode && !isCapacitorApp();
    return (
        <>
            {showDesktopNetworkSettings && <DesktopNetworkSettings />}
            {showPasskeySettings && <PasskeySettings />}
            <PiariumVisualSettings visibleSettings={[
                'fileEditorKeymap',
                'autoSaveEnabled',
                'expandedEditorToolbar',
                ...(!isVSCode ? ['terminalQuickKeys' as const] : []),
                ...(!isVSCode ? ['terminalShell' as const] : []),
                ...(!isVSCode ? ['terminalLoginShell' as const] : []),
                'reportUsage',
            ]} />
        </>
    );
};

// Visual section: Theme Mode, Font Size, Spacing, Input Bar Offset (mobile), Nav Rail
const VisualSectionContent: React.FC = () => {
    const isVSCode = isVSCodeRuntime();
    return <PiariumVisualSettings visibleSettings={[
        'theme',
        'windowControlsPosition',
        'pwaInstallName',
        'pwaOrientation',
        'mobileKeyboardMode',
        'timeFormat',
        ...(!isVSCode ? ['weekStart' as const] : []),
        'fontSize',
        'terminalFontSize',
        'editorFontSize',
        'spacing',
        'inputBarOffset',
    ]} />;
};

// Chat section: User message rendering, Diff layout, Mobile status bar, Show reasoning traces, Follow-up behavior, Persist draft
const ChatSectionContent: React.FC = () => {
    const isVSCode = isVSCodeRuntime();
    return (
        <PiariumVisualSettings
            visibleSettings={[
                'draftStartersVisible',
                'chatRenderMode',
                'activityRenderMode',
                'userMessageRendering',
                'mermaidRendering',
                'reasoning',
                'showToolFileIcons',
                'showTurnChangedFiles',
                'expandedTools',
                'collapsibleUserMessages',
                'stickyUserHeader',
                ...(!isVSCode ? ['promptNavigatorEnabled' as const] : []),
                'wideChatLayout',
                'codeBlockLineWrap',
                'splitAssistantMessageActions',
                'subagentReadOnlyBanner',
                'diffLayout',
                'dotfiles',
                'fileViewerPreview',
                'followUpBehavior',
                'persistDraft',
                'inputSpellcheck',
            ]}
        />
    );
};

// Sessions section: Default model & agent, Session retention
const SessionsSectionContent: React.FC = () => {
    const isVSCode = isVSCodeRuntime();
    return (
        <>
            <DefaultsSettings />
            <SessionRetentionSettings />
            <PiSettingsContributionSlot slot="settings.sessions.panels" />
            {isVSCode && <CheckpointSettings />}
        </>
    );
};

// Git section: Commit message model, Worktree settings
const GitSectionContent: React.FC = () => {
    return <GitSettings />;
};

// GitHub section: Connect account for PR/issue workflows
const GitHubSectionContent: React.FC = () => {
    if (isVSCodeRuntime()) {
        return null;
    }
    return <GitHubSettings />;
};

// Notifications section: Native browser notifications
const NotificationSectionContent: React.FC = () => {
    return <NotificationSettings />;
};

// Voice section: Language selection and continuous mode
const VoiceSectionContent: React.FC = () => {
    if (isVSCodeRuntime()) {
        return null;
    }
    return <VoiceSettings />;
};

const TunnelSectionContent: React.FC = () => {
    if (isVSCodeRuntime()) {
        return null;
    }
    return <TunnelSettings />;
};
