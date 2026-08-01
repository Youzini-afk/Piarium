import type { CacheSnapshot, VirtualizerHandle } from 'virtua';

import type { ChatMessageEntry } from '../turns/types';
import type { ChatVirtualLayoutMode } from './chatItemSizeEstimate';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

// Fix B: timeline (virtualizer measurement) cache for the chat history list.
// Extracted into its own module so it can be unit-tested without pulling the
// markdown/shiki worker (which MessageList.tsx imports transitively through
// ChatMessage). This module imports only types + runtime-surface helpers, so
// it is safe to import in a bun:test context.

const TIMELINE_CACHE_LIMIT = 16;
const VSCODE_TIMELINE_CACHE_LIMIT = 4;
const MOBILE_TIMELINE_CACHE_LIMIT = 4;
// Fix B: restore the virtualizer measurement cache across re-entry into the
// same session. A height-oriented content signature guards it so stale
// heights (different message content length / part structure / render
// dimensions) are not applied — they force a fresh measurement instead.
const RESTORE_TIMELINE_CACHE = true;

export const getTimelineCacheLimit = (): number => {
    if (isVSCodeRuntime()) return VSCODE_TIMELINE_CACHE_LIMIT;
    if (isMobileSurfaceRuntime()) return MOBILE_TIMELINE_CACHE_LIMIT;
    return TIMELINE_CACHE_LIMIT;
};

export const getRuntimeSurfaceKey = (): 'desktop' | 'vscode' | 'mobile' => {
    if (isVSCodeRuntime()) return 'vscode';
    if (isMobileSurfaceRuntime()) return 'mobile';
    return 'desktop';
};

const sameKeys = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return a.every((key, index) => key === b[index]);
};

// Fix B1: height-oriented render dimensions. These are the non-content
// factors that change rendered row heights, so a cache written under one set
// of dimensions must not be restored under another.
export type TimelineRenderDims = {
    virtualLayoutMode: ChatVirtualLayoutMode;
    widthBucket: number;
    chatRenderMode: 'sorted' | 'live';
    runtimeSurface: 'desktop' | 'vscode' | 'mobile';
};

// Structural subset of RenderEntry used for height signing.
type HeightSignableTurn = {
    userMessage: ChatMessageEntry;
    assistantMessages: ReadonlyArray<ChatMessageEntry>;
    summaryText?: unknown;
};
type HeightSignableEntry =
    | { kind: 'ungrouped'; key: string; message: ChatMessageEntry }
    | { kind: 'turn'; key: string; turn: HeightSignableTurn };

// Fix B1: a height-oriented content signature INDEPENDENT of the projection
// signature. Projection signing omits part text entirely (correct for
// projection, which never reads text). Height, however, depends on rendered
// text length, so we sign the LENGTH (not content) of text/content and tool
// output. History entries are settled messages — their text length is stable,
// so signing length does not thrash the cache during streaming (the streaming
// tail lives outside the virtualized history and is never cached here).
const signMessageHeight = (message: ChatMessageEntry): string => {
    const info = message.info as { id?: unknown };
    const id = typeof info.id === 'string' ? info.id : '';
    const roleRaw = message.info as unknown as { clientRole?: unknown; role?: unknown };
    const role = typeof roleRaw.clientRole === 'string' ? roleRaw.clientRole
        : typeof roleRaw.role === 'string' ? roleRaw.role : '';
    const parts: string[] = [`${id}:${role}:${message.parts.length}`];
    for (const part of message.parts) {
        const p = part as {
            type?: unknown;
            id?: unknown;
            text?: unknown;
            content?: unknown;
            state?: { output?: unknown; metadata?: { output?: unknown } };
        };
        const pType = typeof p.type === 'string' ? p.type : '';
        const pId = typeof p.id === 'string' ? p.id : '';
        // Length, not content — catches streaming-length growth of settled
        // messages without embedding the (large) text in the key.
        const text = p.text;
        const content = p.content;
        const textLen = typeof text === 'string' ? text.length
            : typeof content === 'string' ? content.length : 0;
        let outputLen = 0;
        const directOutput = p.state?.output;
        if (typeof directOutput === 'string') {
            outputLen = directOutput.length;
        } else {
            const metaOutput = p.state?.metadata?.output;
            if (typeof metaOutput === 'string') {
                outputLen = metaOutput.length;
            }
        }
        parts.push(`${pType}:${pId}:${textLen}:${outputLen}`);
    }
    return parts.join(',');
};

const signEntryHeight = (entry: HeightSignableEntry): string => {
    if (entry.kind === 'ungrouped') {
        return `${entry.key}|${signMessageHeight(entry.message)}`;
    }
    const turn = entry.turn;
    const userSig = signMessageHeight(turn.userMessage);
    const assistantSig = turn.assistantMessages.map(signMessageHeight).join(',');
    const summaryText = turn.summaryText;
    const summaryLen = typeof summaryText === 'string' ? summaryText.length : 0;
    return `${entry.key}|${userSig}|${assistantSig}|sb=${summaryLen}`;
};

export const buildTimelineHeightSignature = (
    entries: ReadonlyArray<HeightSignableEntry>,
    renderDims: TimelineRenderDims,
): string => {
    const entrySigs = entries.map(signEntryHeight).join(';;');
    return `mode=${renderDims.virtualLayoutMode}|w=${renderDims.widthBucket}|render=${renderDims.chatRenderMode}|surf=${renderDims.runtimeSurface}|${entrySigs}`;
};

// Fix B3: per-session dirty flag. On message content change we mark the
// session dirty so the next entry forces a fresh measurement (does not read
// the stale cache). Once heights settle we rewrite the cache and clear dirty.
const timelineCacheDirtySessions = new Set<string>();

const timelineCache = new Map<string, { keys: readonly string[]; heightSignature: string; cache: CacheSnapshot }>();

export const readTimelineCache = (
    sessionKey: string,
    keys: readonly string[],
    heightSignature: string,
): CacheSnapshot | undefined => {
    if (!RESTORE_TIMELINE_CACHE) return undefined;
    if (timelineCacheDirtySessions.has(sessionKey)) {
        // Content changed since the last stable write — force remeasure.
        timelineCache.delete(sessionKey);
        return undefined;
    }
    const entry = timelineCache.get(sessionKey);
    if (!entry) return undefined;
    if (!sameKeys(entry.keys, keys)) {
        timelineCache.delete(sessionKey);
        return undefined;
    }
    if (entry.heightSignature !== heightSignature) {
        timelineCache.delete(sessionKey);
        return undefined;
    }
    return entry.cache;
};

export const writeTimelineCache = (
    sessionKey: string,
    keys: readonly string[],
    heightSignature: string,
    handle: VirtualizerHandle | null | undefined,
): void => {
    if (!RESTORE_TIMELINE_CACHE) return;
    if (!handle || keys.length === 0) return;
    timelineCache.delete(sessionKey);
    timelineCache.set(sessionKey, { keys: keys.slice(), heightSignature, cache: handle.cache });
    // A fresh stable write supersedes any dirty marker.
    timelineCacheDirtySessions.delete(sessionKey);
    const limit = getTimelineCacheLimit();
    while (timelineCache.size > limit) {
        const oldest = timelineCache.keys().next().value;
        if (typeof oldest !== 'string') break;
        timelineCache.delete(oldest);
    }
};

export const markTimelineCacheDirty = (sessionKey: string): void => {
    if (!RESTORE_TIMELINE_CACHE) return;
    timelineCacheDirtySessions.add(sessionKey);
};

// Test helper: clear module-level cache state for deterministic tests.
export const __resetTimelineCacheForTests = (): void => {
    timelineCache.clear();
    timelineCacheDirtySessions.clear();
};
