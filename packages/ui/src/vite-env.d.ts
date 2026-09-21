/// <reference types="vite/client" />

interface Window {
    __VARIN_HOME__?: string;
    __varinDebug?: {
        getCurrentSession: () => unknown;
        getLastAssistantMessage: () => unknown;
        getAllMessages: (truncate?: boolean) => unknown[];
        getSessionEntries: (scope?: 'all' | 'branch') => unknown;
        getAppStatus: () => Promise<unknown>;
        checkLastMessage: () => boolean;
        findEmptyMessages: () => unknown[];
        showRetryHelp: () => void;
        getRuntimeState: () => unknown;
        buildDiagnosticsReport: () => Promise<string>;
        copyDiagnosticsReport: () => Promise<unknown>;
        copyTextToClipboard: (text: string) => Promise<unknown>;
        checkCompletionStatus: () => unknown;
    };
}
