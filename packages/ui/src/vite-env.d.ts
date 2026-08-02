/// <reference types="vite/client" />

interface Window {
    __PIARIUM_HOME__?: string;
    __opencodeDebug?: {
        getLastAssistantMessage: () => unknown;
        getAllMessages: (truncate?: boolean) => unknown[];
        truncateMessages: (messages: unknown[]) => unknown[];
        getAppStatus: () => Promise<unknown>;
        checkLastMessage: () => boolean;
        findEmptyMessages: () => unknown[];
        showRetryHelp: () => void;
        getStreamingState: () => unknown;
        analyzeMessageCompletionConsistency: (options?: unknown) => unknown;
        checkCompletionStatus: () => unknown;
    };
}
