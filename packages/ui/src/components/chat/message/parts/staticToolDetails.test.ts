import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@opencode-ai/sdk/v2';

import { buildStaticToolDetailEntries, formatStaticToolDetailValue } from './staticToolDetails';

describe('static tool details', () => {
    test('formats strings and structured values for display', () => {
        expect(formatStaticToolDetailValue('  hello  ')).toBe('hello');
        expect(formatStaticToolDetailValue({ pattern: 'foo', paths: ['src'] })).toBe(JSON.stringify({ pattern: 'foo', paths: ['src'] }, null, 2));
        expect(formatStaticToolDetailValue({})).toBe(undefined);
        expect(formatStaticToolDetailValue('   ')).toBe(undefined);
    });

    test('builds detail entries from static tool state', () => {
        const part = {
            id: 'tool-1',
            type: 'tool',
            tool: 'grep',
            state: {
                status: 'completed',
                input: { pattern: 'Thinking' },
                output: 'packages/ui/src/file.tsx:42',
                metadata: { count: 1 },
            },
        } as unknown as ToolPart;

        expect(buildStaticToolDetailEntries([{ id: 'tool-1', part }])).toEqual([
            {
                id: 'tool-1',
                input: JSON.stringify({ pattern: 'Thinking' }, null, 2),
                output: 'packages/ui/src/file.tsx:42',
                error: undefined,
                metadata: JSON.stringify({ count: 1 }, null, 2),
            },
        ]);
    });
});
