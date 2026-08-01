import { describe, expect, test } from 'bun:test';

import type { ChatMessageEntry } from './lib/turns/types';
import type { CacheSnapshot, VirtualizerHandle } from 'virtua';
import {
    buildTimelineHeightSignature,
    readTimelineCache,
    writeTimelineCache,
    markTimelineCacheDirty,
    __resetTimelineCacheForTests,
    type TimelineRenderDims,
} from './lib/virtualization/timelineCache';

// Minimal message/part builders. We only sign structural fields + text length,
// so the objects can be sparse (cast through unknown to satisfy the SDK types).
const makeTextPart = (id: string, text: string) => ({ type: 'text', id, text });
const makeMessage = (id: string, role: string, parts: unknown[]): ChatMessageEntry => ({
    info: { id, role } as unknown as ChatMessageEntry['info'],
    parts: parts as unknown as ChatMessageEntry['parts'],
});

const makeUngroupedEntry = (message: ChatMessageEntry) => ({
    kind: 'ungrouped' as const,
    key: `msg:${message.info.id}`,
    message,
});

const makeTurnEntry = (
    userMessage: ChatMessageEntry,
    assistantMessages: ChatMessageEntry[],
    summaryText?: string,
) => ({
    kind: 'turn' as const,
    key: `turn:${userMessage.info.id}`,
    turn: { userMessage, assistantMessages, summaryText },
});

const makeFakeHandle = (cacheMarker: string): VirtualizerHandle => ({
    cache: { __marker: cacheMarker } as unknown as CacheSnapshot,
} as unknown as VirtualizerHandle);

const baseRenderDims: TimelineRenderDims = {
    virtualLayoutMode: 'standard',
    widthBucket: 20,
    chatRenderMode: 'sorted',
    runtimeSurface: 'desktop',
};

const sampleEntries = () => [
    makeTurnEntry(
        makeMessage('u1', 'user', [makeTextPart('p1', 'hello world')]),
        [makeMessage('a1', 'assistant', [makeTextPart('p2', 'response text here')])],
        'summary body',
    ),
    makeUngroupedEntry(
        makeMessage('m2', 'assistant', [makeTextPart('p3', 'another one')]),
    ),
];

describe('buildTimelineHeightSignature', () => {
    test('identical entries + dims produce identical signatures (cache-hit prerequisite)', () => {
        const entries = sampleEntries();
        const a = buildTimelineHeightSignature(entries, baseRenderDims);
        const b = buildTimelineHeightSignature(sampleEntries(), baseRenderDims);
        expect(a).toBe(b);
    })

    test('text LENGTH change invalidates the signature (cache miss)', () => {
        const entries = sampleEntries();
        const before = buildTimelineHeightSignature(entries, baseRenderDims);
        // Grow the assistant response text — length changes → signature changes.
        const grown = [
            makeTurnEntry(
                makeMessage('u1', 'user', [makeTextPart('p1', 'hello world')]),
                [makeMessage('a1', 'assistant', [makeTextPart('p2', 'response text here and more')])],
                'summary body',
            ),
            entries[1],
        ];
        const after = buildTimelineHeightSignature(grown, baseRenderDims);
        expect(after).not.toBe(before)
    })

    test('text CONTENT change without length change keeps the signature (settled-message stability)', () => {
        // History entries are settled messages; swapping text of the same length
        // does not change rendered height, so the cache stays hot. This is the
        // length-not-content property from Fix B1.
        const entries = sampleEntries();
        const before = buildTimelineHeightSignature(entries, baseRenderDims);
        const sameLength = [
            makeTurnEntry(
                makeMessage('u1', 'user', [makeTextPart('p1', 'world hello')]),
                [makeMessage('a1', 'assistant', [makeTextPart('p2', 'here response text')])],
                'summary body',
            ),
            entries[1],
        ];
        const after = buildTimelineHeightSignature(sameLength, baseRenderDims);
        expect(after).toBe(before)
    })

    test('part count change invalidates the signature', () => {
        const entries = sampleEntries();
        const before = buildTimelineHeightSignature(entries, baseRenderDims);
        const withExtraPart = [
            makeTurnEntry(
                makeMessage('u1', 'user', [makeTextPart('p1', 'hello world')]),
                [makeMessage('a1', 'assistant', [
                    makeTextPart('p2', 'response text here'),
                    { type: 'tool', id: 't1', tool: 'bash', state: { output: 'done' } },
                ])],
                'summary body',
            ),
            entries[1],
        ];
        const after = buildTimelineHeightSignature(withExtraPart, baseRenderDims);
        expect(after).not.toBe(before)
    })

    test('renderDims change (layoutMode) invalidates the signature', () => {
        const entries = sampleEntries();
        const standard = buildTimelineHeightSignature(entries, baseRenderDims);
        const wide = buildTimelineHeightSignature(entries, { ...baseRenderDims, virtualLayoutMode: 'wide' });
        expect(wide).not.toBe(standard)
    })

    test('renderDims change (width bucket) invalidates the signature', () => {
        const entries = sampleEntries();
        const narrow = buildTimelineHeightSignature(entries, { ...baseRenderDims, widthBucket: 12 });
        const wide = buildTimelineHeightSignature(entries, { ...baseRenderDims, widthBucket: 30 });
        expect(wide).not.toBe(narrow)
    })

    test('renderDims change (runtime surface) invalidates the signature', () => {
        const entries = sampleEntries();
        const desktop = buildTimelineHeightSignature(entries, { ...baseRenderDims, runtimeSurface: 'desktop' });
        const vscode = buildTimelineHeightSignature(entries, { ...baseRenderDims, runtimeSurface: 'vscode' });
        expect(vscode).not.toBe(desktop)
    })
})

describe('timelineCache read/write (Fix B2)', () => {
    test('re-entering the same session with unchanged content → cache hit', () => {
        __resetTimelineCacheForTests();
        const sessionKey = 'ses_cache_hit';
        const entries = sampleEntries();
        const keys = entries.map((e) => e.key);
        const sig = buildTimelineHeightSignature(entries, baseRenderDims);
        const handle = makeFakeHandle('hit');
        writeTimelineCache(sessionKey, keys, sig, handle);

        const restored = readTimelineCache(sessionKey, keys, sig);
        expect(restored).toBe(handle.cache);
    })

    test('content length change between write and read → cache miss', () => {
        __resetTimelineCacheForTests();
        const sessionKey = 'ses_cache_miss_content';
        const entries = sampleEntries();
        const keys = entries.map((e) => e.key);
        const writeSig = buildTimelineHeightSignature(entries, baseRenderDims);
        writeTimelineCache(sessionKey, keys, writeSig, makeFakeHandle('stale'));

        // Content grew (length change) → read signature differs → miss.
        const grown = [
            makeTurnEntry(
                makeMessage('u1', 'user', [makeTextPart('p1', 'hello world')]),
                [makeMessage('a1', 'assistant', [makeTextPart('p2', 'response text here and more')])],
                'summary body',
            ),
            entries[1],
        ];
        const readSig = buildTimelineHeightSignature(grown, baseRenderDims);
        const restored = readTimelineCache(sessionKey, grown.map((e) => e.key), readSig);
        expect(restored).toBeUndefined();
    })

    test('keys change (different entries) → cache miss', () => {
        __resetTimelineCacheForTests();
        const sessionKey = 'ses_cache_miss_keys';
        const entries = sampleEntries();
        const keys = entries.map((e) => e.key);
        const sig = buildTimelineHeightSignature(entries, baseRenderDims);
        writeTimelineCache(sessionKey, keys, sig, makeFakeHandle('old'));

        // Different keys (a new turn prepended) → miss.
        const newKeys = ['turn:u0', ...keys];
        const restored = readTimelineCache(sessionKey, newKeys, sig);
        expect(restored).toBeUndefined();
    })

    test('dirty session forces a miss even with matching keys + signature', () => {
        __resetTimelineCacheForTests();
        const sessionKey = 'ses_dirty';
        const entries = sampleEntries();
        const keys = entries.map((e) => e.key);
        const sig = buildTimelineHeightSignature(entries, baseRenderDims);
        writeTimelineCache(sessionKey, keys, sig, makeFakeHandle('v1'));
        // Before dirtying: hit.
        expect(readTimelineCache(sessionKey, keys, sig)).toBeDefined();

        // A content change marks the session dirty → next read misses even
        // though keys + signature still match (forces a fresh measurement).
        markTimelineCacheDirty(sessionKey);
        expect(readTimelineCache(sessionKey, keys, sig)).toBeUndefined();

        // A fresh stable write (measurement-rewrite loop) clears dirty → hit again.
        const handleV2 = makeFakeHandle('v2');
        writeTimelineCache(sessionKey, keys, sig, handleV2);
        expect(readTimelineCache(sessionKey, keys, sig)).toBe(handleV2.cache);
    })

    test('runtime cache limit caps the number of cached sessions (degradation under constrained runtimes)', () => {
        __resetTimelineCacheForTests();
        // The cap is runtime-aware: desktop 16, vscode/mobile 4. We can't flip
        // the runtime in a unit test, so assert the LRU eviction behavior itself
        // (the cap mechanism) by writing more than the smallest cap and checking
        // older entries are evicted. Under desktop this would need >16 writes;
        // assert the cap is enforced by verifying at most the limit is retained
        // and the oldest is dropped first.
        const entries = sampleEntries();
        const keys = entries.map((e) => e.key);
        const sig = buildTimelineHeightSignature(entries, baseRenderDims);

        // Write a baseline known-good entry we expect to keep while under cap.
        writeTimelineCache('keep', keys, sig, makeFakeHandle('keep'));

        // Writing a huge number of additional sessions exceeds any runtime cap.
        for (let i = 0; i < 64; i += 1) {
            writeTimelineCache(`bulk_${i}`, keys, sig, makeFakeHandle(`b${i}`));
        }

        // 'keep' was the oldest before the bulk writes; with a cap it should
        // have been evicted (LRU). The cache Map must not exceed the cap.
        // We can't read the Map size directly, but reading 'keep' must now miss.
        expect(readTimelineCache('keep', keys, sig)).toBeUndefined();

        // The most-recent write is still present (within cap).
        expect(readTimelineCache('bulk_63', keys, sig)).toBeDefined();
        __resetTimelineCacheForTests();
    })
})
