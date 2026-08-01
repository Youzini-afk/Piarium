import type { Part } from '@opencode-ai/sdk/v2';

type ToolActivityLike = {
    id: string;
    part: Part;
};

type RecordLike = Record<string, unknown>;

export type StaticToolDetailEntry = {
    id: string;
    input?: string;
    output?: string;
    error?: string;
    metadata?: string;
};

const isRecord = (value: unknown): value is RecordLike => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const formatStaticToolDetailValue = (value: unknown): string | undefined => {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    try {
        const serialized = JSON.stringify(value, null, 2);
        return serialized && serialized !== '{}' && serialized !== '[]' ? serialized : undefined;
    } catch {
        return undefined;
    }
};

export const buildStaticToolDetailEntries = (activities: ToolActivityLike[]): StaticToolDetailEntry[] => {
    return activities
        .map((activity) => {
            const toolPart = activity.part as unknown as { state?: unknown; metadata?: unknown };
            const state = isRecord(toolPart.state) ? toolPart.state : undefined;
            const partMetadata = isRecord((activity.part as unknown as { metadata?: unknown }).metadata)
                ? (activity.part as unknown as { metadata: RecordLike }).metadata
                : undefined;

            const entry: StaticToolDetailEntry = {
                id: activity.id,
                input: formatStaticToolDetailValue(state?.input),
                output: formatStaticToolDetailValue(state?.output),
                error: formatStaticToolDetailValue(state?.error),
                metadata: formatStaticToolDetailValue(state?.metadata ?? partMetadata),
            };

            return entry.input || entry.output || entry.error || entry.metadata ? entry : null;
        })
        .filter((entry): entry is StaticToolDetailEntry => entry !== null);
};
