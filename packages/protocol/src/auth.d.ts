import type { ProviderAuthType } from "./types.js";
export type ProviderCredentialSource = "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
export interface ProviderAuthMethodDescriptor {
    label: string;
    type: ProviderAuthType;
}
export interface ProviderDescriptor {
    auth: {
        configured: boolean;
        label?: string;
        methods: ProviderAuthMethodDescriptor[];
        source?: ProviderCredentialSource;
    };
    baseUrl?: string;
    dynamicModels: boolean;
    id: string;
    modelCount: number;
    name: string;
}
interface ProviderAuthPromptBase {
    message: string;
    requestId: string;
}
export type ProviderAuthPrompt = (ProviderAuthPromptBase & {
    placeholder?: string;
    type: "text" | "secret" | "manual_code";
}) | (ProviderAuthPromptBase & {
    options: Array<{
        description?: string;
        id: string;
        label: string;
    }>;
    type: "select";
});
export interface ProviderAuthPromptRequest {
    prompt: ProviderAuthPrompt;
    providerId: string;
    sessionId: string;
}
export interface ProviderAuthResponse {
    cancelled?: boolean;
    requestId: string;
    value?: string;
}
export type ProviderAuthEvent = {
    links?: Array<{
        label?: string;
        url: string;
    }>;
    message: string;
    type: "info";
} | {
    instructions?: string;
    type: "auth_url";
    url: string;
} | {
    expiresInSeconds?: number;
    intervalSeconds?: number;
    type: "device_code";
    userCode: string;
    verificationUri: string;
} | {
    message: string;
    type: "progress";
};
export {};
//# sourceMappingURL=auth.d.ts.map