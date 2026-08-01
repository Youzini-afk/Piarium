import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';

type SessionMessageRecord = { info: Message; parts: Part[] };

/**
 * Pure cursor-based plan-marker scan. Extracted from usePlanDetection so the
 * scanning behavior (only walk the newly appended tail, not the whole history)
 * is unit-testable without rendering the hook.
 *
 * Returns `{ found, nextCursor }`. The hook stores `nextCursor` in a ref and
 * passes it back as `startIndex` on the next run, so each effect invocation
 * only walks `[startIndex, length)` — O(delta) instead of O(N) per streaming
 * part delta.
 *
 * The cursor is advanced to `Math.max(end - 1, startIndex)` instead of `end`.
 * This intentionally keeps the last scanned message in the next scan window.
 * During streaming, the last assistant message's text part grows in place —
 * the same part object accumulates content, and the plan marker ("The plan
 * at …") may be appended to a message that was already scanned and found
 * clean. If we advanced the cursor past it, we'd never re-check it and miss
 * the marker. Keeping it in the window costs one extra message re-scan per
 * effect run — O(1), not O(N).
 */
export const scanForPlanMarker = (
    messageRecords: SessionMessageRecord[],
    startIndex: number,
): { found: boolean; nextCursor: number } => {
    const end = messageRecords.length;
    if (startIndex >= end) {
        return { found: false, nextCursor: startIndex };
    }

    for (let index = startIndex; index < end; index += 1) {
        const message = messageRecords[index];
        if (!message) continue;
        // Only check assistant messages for plan references
        if (message.info.role !== 'assistant') continue;

        for (const part of message.parts) {
            const record = part as { type?: string; text?: string };
            if (record.type !== 'text') continue;
            const text = record.text || '';

            // Check for plan file reference in synthetic messages
            if (text.includes('The plan at ') || text.includes('User has requested to enter plan mode')) {
                return { found: true, nextCursor: index + 1 };
            }
        }
    }

    // Keep the last scanned message in the next scan window. During streaming,
    // the trailing assistant message's text part grows in place; advancing
    // past it would miss a marker appended after the first clean scan.
    // Clamp to startIndex so we never go backwards (e.g. when the array
    // shrank due to a session switch handled by the hook's reset).
    const nextCursor = Math.max(end - 1, startIndex);
    return { found: false, nextCursor };
};

/**
 * Watches session messages for plan creation and marks sessions as plan-available.
 *
 * This is the single source of truth for plan detection. When a plan_enter tool
 * executes, it creates a synthetic message like "The plan at ${path}" or
 * "User has requested to enter plan mode". We detect these and signal availability.
 *
 * The Header component subscribes to sessionPlanAvailable map to show/hide the Plan tab.
 */
export const usePlanDetection = (sessionId: string, messageRecords: SessionMessageRecord[]) => {
    const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
    const markSessionPlanAvailable = useSessionUIStore((state) => state.markSessionPlanAvailable);
    const isSessionPlanAvailable = useSessionUIStore((state) => state.isSessionPlanAvailable);

    // Cursor that records how far through messageRecords we have already scanned.
    // Each effect run only scans the newly appended tail [cursor, length). This
    // keeps plan detection O(delta) instead of re-walking the whole session on
    // every streaming part delta.
    const lastScannedEndRef = React.useRef(0);
    // Tracks the first message id seen for the current session. If it changes
    // (older history was prepended, or the session was switched), we reset the
    // cursor and re-scan from the start so prepended records are not missed.
    const lastScannedFirstIdRef = React.useRef<string | null>(null);

    // Reset the cursor whenever the session changes — a different session means
    // the cached indices no longer correspond to the same records.
    React.useEffect(() => {
        lastScannedEndRef.current = 0;
        lastScannedFirstIdRef.current = null;
    }, [sessionId]);

    React.useEffect(() => {
        // Early exit if plan mode is disabled - don't parse messages
        if (!planModeEnabled) return;
        if (!sessionId) return;

        // Already marked as available - no need to check again
        if (isSessionPlanAvailable(sessionId)) return;

        // If the leading message changed (prepend or reordering), the cached
        // cursor no longer lines up with the new array — reset and re-scan.
        const currentFirstId = messageRecords[0]?.info?.id ?? null;
        if (currentFirstId !== lastScannedFirstIdRef.current) {
            lastScannedEndRef.current = 0;
            lastScannedFirstIdRef.current = currentFirstId;
        }

        const result = scanForPlanMarker(messageRecords, lastScannedEndRef.current);
        if (result.found) {
            markSessionPlanAvailable(sessionId);
            return;
        }
        lastScannedEndRef.current = result.nextCursor;
    }, [planModeEnabled, sessionId, messageRecords, markSessionPlanAvailable, isSessionPlanAvailable]);
};
