import type { ChatMessageEntry, TurnProjectionResult } from './types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

const TURN_PROJECTION_CACHE_MAX = 30;
const VSCODE_TURN_PROJECTION_CACHE_MAX = 4;
const MOBILE_TURN_PROJECTION_CACHE_MAX = 4;

const projectionCache = new Map<string, TurnProjectionResult>();

const getProjectionCacheMax = () => {
  if (isVSCodeRuntime()) return VSCODE_TURN_PROJECTION_CACHE_MAX;
  if (isMobileSurfaceRuntime()) return MOBILE_TURN_PROJECTION_CACHE_MAX;
  return TURN_PROJECTION_CACHE_MAX;
};

/**
 * Build a cheap STRUCTURAL signature for one message. This captures every
 * field that turn projection / retry overlay / diff-stats / activity
 * segmentation / summary text actually read — WITHOUT including part text
 * content (which changes on every streaming delta).
 *
 * Signed fields per message:
 *   - info.id, info.role, clientRole, parentID  (turn grouping boundaries)
 *   - info.finish                                (stream state, justification gating)
 *   - info.error (name + message + data.message) (retry overlay error text)
 *   - info.time.completed                        (stream state, isCompleted)
 *   - info.summary.body                          (summaryText fallback)
 *   - info.summary.diffs (file/additions/deletions per diff)  (diffStats / changedFiles)
 *   - parts.length                               (new part appended)
 *   - per part: type + id                        (part kind changes, tool reveal)
 *   - per tool part: tool name                   (standalone tool grouping)
 *   - per part: state.time.end / time.end        (activity endedAt, segmentation)
 *
 * NOT signed: part.text, part.content, part.tool.state.output — these are the
 * streaming hot-path fields that grow ~60/sec. Signing them would force an
 * O(N) rebuild on every frame; not signing them means streaming text growth
 * keeps the cache hit (Fix 7's performance goal) while structural changes
 * (tool part added, finish state flipped, error attached, diffs updated,
 * tool name changed, part end time changed) correctly invalidate.
 */
const buildMessageStructuralSignature = (message: ChatMessageEntry): string => {
    const info = message.info as Record<string, unknown>;
    const id = typeof info.id === 'string' ? info.id : '';
    const role = typeof info.role === 'string' ? info.role : '';
    const clientRole = typeof info.clientRole === 'string' ? info.clientRole : '';
    const parentID = typeof info.parentID === 'string' ? info.parentID : '';
    const finish = typeof info.finish === 'string' ? info.finish : '';

    // Sign error content (name + message + data.message), not just presence.
    // retry overlay attaches an error with name/message; changing the error
    // text (e.g. different retry message) must invalidate the cache.
    const errorRaw = info.error;
    let errorSig = '0';
    if (errorRaw && typeof errorRaw === 'object') {
        const e = errorRaw as {
            name?: unknown;
            message?: unknown;
            data?: unknown;
        };
        const eName = typeof e.name === 'string' ? e.name : '';
        const eMessage = typeof e.message === 'string' ? e.message : '';
        let eDataMessage = '';
        if (e.data && typeof e.data === 'object') {
            const dm = (e.data as { message?: unknown }).message;
            eDataMessage = typeof dm === 'string' ? dm : '';
        } else if (typeof e.data === 'string') {
            eDataMessage = e.data;
        }
        errorSig = `${eName}:${eMessage}:${eDataMessage}`;
    }

    // time.completed drives isAssistantMessageCompleted and stream state.
    const time = info.time as { completed?: unknown } | undefined;
    const completed = typeof time?.completed === 'number' ? time.completed : 0;

    // summary.body drives summaryText (getUserSummaryBody fallback).
    const summary = info.summary as { body?: unknown; diffs?: unknown[] } | undefined;
    const summaryBody = typeof summary?.body === 'string' ? summary.body : '';

    // summary.diffs drives diffStats + changedFiles projection. Sign the
    // structural fields (additions/deletions/file) so a diff arriving or
    // changing counts invalidates, without signing the whole summary object
    // reference (which would miss in-place mutation).
    const diffs = summary?.diffs;
    let diffsSig = '';
    if (Array.isArray(diffs)) {
        diffsSig = diffs.map((diff) => {
            if (!diff || typeof diff !== 'object') return '';
            const d = diff as { file?: unknown; additions?: unknown; deletions?: unknown };
            const file = typeof d.file === 'string' ? d.file : '';
            const additions = typeof d.additions === 'number' ? d.additions : 0;
            const deletions = typeof d.deletions === 'number' ? d.deletions : 0;
            return `${file}:${additions}:${deletions}`;
        }).join(',');
    }

    // Per-part structural signature. Beyond type + id, sign the cheap
    // structural fields that projection actually reads:
    //   - tool name (part.tool) — drives standalone-tool activity grouping
    //   - state.time.end / time.end — drives activity endedAt + segmentation
    // Do NOT sign text/content/output (streaming hot-path fields).
    const partsSig = message.parts.map((part) => {
        const p = part as {
            type?: string;
            id?: string;
            tool?: unknown;
            state?: { time?: { end?: unknown } };
            time?: { end?: unknown };
        };
        const pType = typeof p.type === 'string' ? p.type : '';
        const pId = typeof p.id === 'string' ? p.id : '';

        // Tool name: can be a string or an object with an id/name field.
        let toolNameSig = '';
        if (p.type === 'tool' && p.tool !== undefined && p.tool !== null) {
            if (typeof p.tool === 'string') {
                toolNameSig = p.tool;
            } else if (typeof p.tool === 'object') {
                const t = p.tool as { id?: unknown; name?: unknown };
                const tId = typeof t.id === 'string' ? t.id : '';
                const tName = typeof t.name === 'string' ? t.name : '';
                toolNameSig = `${tId}:${tName}`;
            }
        }

        // Part end time: drives activity endedAt + segmentation boundaries.
        const stateEnd = p.state?.time?.end;
        const timeEnd = p.time?.end;
        const endSig = typeof stateEnd === 'number' ? stateEnd
            : typeof timeEnd === 'number' ? timeEnd
            : 0;

        return `${pType}:${pId}:${toolNameSig}:${endSig}`;
    }).join(',');

    return `${id}:${role}:${clientRole}:${parentID}:${finish}:${errorSig}:${completed}:${summaryBody}:${diffsSig}:${message.parts.length}:${partsSig}`;
};

const buildMessagesVersionSignature = (messages: ChatMessageEntry[]): string => {
    // Structural signature across ALL messages. This replaces the previous
    // coarse edge-only key (messages.length + lastMessage.info ref + first id)
    // which missed interior changes: a tool part added to a middle assistant
    // message, a finish/error flip on a non-tail message, a user summary.diffs
    // update, or a retry overlay attaching an error to a non-tail assistant.
    // All of those change projection output and must invalidate the cache.
    //
    // The signature is cheap: it reads only structural fields (id/role/type/
    // finish/error/completed/diffs) and never reads part text content, so
    // streaming text growth (~60/sec) does NOT produce a new key — the cache
    // stays hot during streaming (Fix 7 performance goal preserved) while
    // structural changes correctly miss and force a fresh projection.
    return messages.map(buildMessageStructuralSignature).join(';');
};

export const buildProjectionCacheKey = (
  sessionKey: string,
  messages: ChatMessageEntry[],
  showTextJustificationActivity: boolean,
  showTurnChangedFiles: boolean,
  mergeHiddenUserTurnsKey: string,
): string => {
  return [
    sessionKey,
    buildMessagesVersionSignature(messages),
    showTextJustificationActivity ? '1' : '0',
    showTurnChangedFiles ? '1' : '0',
    mergeHiddenUserTurnsKey,
  ].join('|');
};

export const getCachedProjection = (key: string): TurnProjectionResult | undefined => {
  const cached = projectionCache.get(key);
  if (cached) {
    // LRU re-order: move hit to the end (most recent) so it survives
    // eviction longer than entries that haven't been read recently.
    projectionCache.delete(key);
    projectionCache.set(key, cached);
  }
  return cached;
};

export const setCachedProjection = (
  key: string,
  projection: TurnProjectionResult,
): void => {
  projectionCache.delete(key);
  const max = getProjectionCacheMax();
  while (projectionCache.size >= max) {
    const oldest = projectionCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    projectionCache.delete(oldest);
  }
  projectionCache.set(key, projection);
};
