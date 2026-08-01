import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { scanForPlanMarker } from './usePlanDetection';

type SessionMessageRecord = { info: Message; parts: Part[] };

const createRecord = (
    id: string,
    role: 'user' | 'assistant' | 'system' = 'assistant',
    text: string = 'no plan here',
): SessionMessageRecord => ({
    info: { id, role } as Message,
    parts: [{ id: `prt_${id}`, type: 'text', text } as Part],
});

describe('scanForPlanMarker', () => {
    test('returns found=false and cursor=0 for an empty record list', () => {
        const result = scanForPlanMarker([], 0);
        expect(result.found).toBe(false);
        expect(result.nextCursor).toBe(0);
    });

    test('returns found=false when startIndex is at or past the end', () => {
        const records = [createRecord('msg_1')];
        expect(scanForPlanMarker(records, 1)).toEqual({ found: false, nextCursor: 1 });
        expect(scanForPlanMarker(records, 5)).toEqual({ found: false, nextCursor: 5 });
    });

    test('detects "The plan at" plan marker in an assistant text part', () => {
        const records = [
            createRecord('msg_1', 'user'),
            createRecord('msg_2', 'assistant', 'The plan at /path/to/plan.md'),
        ];
        const result = scanForPlanMarker(records, 0);
        expect(result.found).toBe(true);
        // When found, cursor advances PAST the found message (index + 1).
        expect(result.nextCursor).toBe(2);
    });

    test('detects "User has requested to enter plan mode" marker', () => {
        const records = [
            createRecord('msg_1', 'assistant', 'User has requested to enter plan mode'),
        ];
        const result = scanForPlanMarker(records, 0);
        expect(result.found).toBe(true);
    });

    test('skips non-assistant messages', () => {
        const records = [
            createRecord('msg_1', 'user', 'The plan at /path'),
        ];
        const result = scanForPlanMarker(records, 0);
        expect(result.found).toBe(false);
        // Cursor keeps the last message in the window (Math.max(end-1, start)).
        expect(result.nextCursor).toBe(0); // end=1, max(1-1, 0) = 0
    });

    test('skips non-text parts', () => {
        const records: SessionMessageRecord[] = [
            {
                info: { id: 'msg_1', role: 'assistant' } as Message,
                parts: [{ id: 'prt_1', type: 'tool' } as Part],
            },
        ];
        const result = scanForPlanMarker(records, 0);
        expect(result.found).toBe(false);
    });

    test('5000 records with no plan + append 1 plan marker → only scans the new tail', () => {
        // Build 5000 records with no plan marker.
        const records: SessionMessageRecord[] = [];
        for (let i = 0; i < 5000; i += 1) {
            records.push(createRecord(`msg_${i}`, 'assistant', `assistant message ${i}`));
        }

        // First scan: walks all 5000 records, finds no plan. Cursor advances
        // to Math.max(5000 - 1, 0) = 4999 — keeps the last scanned message
        // in the window because it may still grow a marker during streaming.
        const first = scanForPlanMarker(records, 0);
        expect(first.found).toBe(false);
        expect(first.nextCursor).toBe(4999);

        // Append 1 record with a plan marker at the end.
        records.push(
            createRecord('msg_5000', 'assistant', 'The plan at /path/to/plan.md'),
        );

        // Second scan: starts from cursor 4999, scans [4999, 5001).
        // That's 2 iterations (the re-scanned last message + the new one),
        // NOT 5001 iterations. Still O(delta), not O(N).
        const second = scanForPlanMarker(records, first.nextCursor);
        expect(second.found).toBe(true);
        expect(second.nextCursor).toBe(5001);
    });

    test('5000 records with no plan + append 1 without plan → cursor keeps last message', () => {
        const records: SessionMessageRecord[] = [];
        for (let i = 0; i < 5000; i += 1) {
            records.push(createRecord(`msg_${i}`, 'assistant', `text ${i}`));
        }

        const first = scanForPlanMarker(records, 0);
        // Cursor = Math.max(5000 - 1, 0) = 4999.
        expect(first.nextCursor).toBe(4999);

        records.push(createRecord('msg_5000', 'assistant', 'still no plan'));

        const second = scanForPlanMarker(records, first.nextCursor);
        expect(second.found).toBe(false);
        // Cursor = Math.max(5001 - 1, 4999) = 5000.
        expect(second.nextCursor).toBe(5000);
    });

    test('stops at the first plan marker found', () => {
        const records = [
            createRecord('msg_1', 'assistant', 'The plan at /first.md'),
            createRecord('msg_2', 'assistant', 'The plan at /second.md'),
        ];
        const result = scanForPlanMarker(records, 0);
        expect(result.found).toBe(true);
        expect(result.nextCursor).toBe(1);
    });

    test('cursor never goes backwards — clamps to startIndex when array shrinks', () => {
        // If the array shrank (session switch handled by the hook's reset),
        // the cursor must not go below startIndex. Math.max(end-1, start)
        // guarantees this: if end-1 < start, we keep start.
        const records = [createRecord('msg_1', 'assistant', 'no plan')];
        // startIndex=5, end=1 → Math.max(1-1, 5) = 5. No backwards movement.
        const result = scanForPlanMarker(records, 5);
        expect(result.found).toBe(false);
        expect(result.nextCursor).toBe(5);
    });

    // -----------------------------------------------------------------------
    // Blocker 1: streaming completion of a plan marker in the SAME message.
    // -----------------------------------------------------------------------
    test('BLOCKER 1: marker appended to a previously-clean assistant message is detected', () => {
        // Simulate the streaming scenario:
        // 1. First scan: single assistant message, no plan marker yet.
        // 2. The SAME message's text part grows (streaming delta) and the
        //    plan marker appears. Array length does NOT change.
        // 3. Second scan must detect the marker.

        // Step 1: single assistant message with clean text.
        const records: SessionMessageRecord[] = [
            createRecord('msg_1', 'assistant', 'starting work'),
        ];

        const first = scanForPlanMarker(records, 0);
        expect(first.found).toBe(false);
        // Cursor = Math.max(1 - 1, 0) = 0 — keeps the last (only) message
        // in the scan window because it's the streaming tail.
        expect(first.nextCursor).toBe(0);

        // Step 2: the SAME part object grows text in place — now includes
        // the plan marker. The array reference and length are unchanged;
        // only the part's text mutated.
        (records[0]!.parts[0] as { text?: string }).text =
            'starting work... The plan at /path/to/plan.md';

        // Step 3: second scan starts from cursor 0 (kept in window).
        // With the OLD cursor behavior (nextCursor = end = 1), the second
        // scan would start at index 1, find nothing, and miss the marker.
        // With the fix (nextCursor = max(end-1, start) = 0), the second
        // scan re-checks index 0 and finds the marker.
        const second = scanForPlanMarker(records, first.nextCursor);
        expect(second.found).toBe(true);
    });

    test('BLOCKER 1: cursor keeps last message even after scanning multiple clean records', () => {
        // 3 clean assistant messages. After scanning, cursor = max(3-1, 0) = 2.
        // The 3rd message (index 2) stays in the window. If its text later
        // grows a marker, the next scan re-checks it.
        const records: SessionMessageRecord[] = [
            createRecord('msg_1', 'assistant', 'text 1'),
            createRecord('msg_2', 'assistant', 'text 2'),
            createRecord('msg_3', 'assistant', 'text 3'),
        ];

        const first = scanForPlanMarker(records, 0);
        expect(first.found).toBe(false);
        expect(first.nextCursor).toBe(2); // max(3-1, 0) = 2

        // The last message's text grows a marker in place.
        (records[2]!.parts[0] as { text?: string }).text =
            'text 3 The plan at /plan.md';

        const second = scanForPlanMarker(records, first.nextCursor);
        expect(second.found).toBe(true);
    });
});
