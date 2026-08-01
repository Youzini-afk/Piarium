import { parsePatchFiles } from '@pierre/diffs';

export type DiffPatchEntry = {
    id: string;
    title: string;
    patch: string;
    renderMode: 'diff' | 'text';
};

const APPLY_PATCH_ENVELOPE_PATTERN = /^\*\*\*\s+(?:Begin Patch|End Patch|Add File:|Update File:|Delete File:|Move to:)/m;
const HUNK_HEADER_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m;
const GIT_DIFF_FILE_BREAK_PATTERN = /(?=^diff --git\s+)/gm;
const GIT_DIFF_FILE_BREAK_TEST = /^diff --git\s+/m;
const UNIFIED_DIFF_FILE_BREAK_PATTERN = /(?=^---\s+\S)/gm;
const UNIFIED_DIFF_FILE_BREAK_TEST = /^---\s+\S/m;
const APPLY_PATCH_FILE_HEADER_PATTERN = /^\*\*\*\s+(Add File|Update File|Delete File):\s+(.+)$/;
const APPLY_PATCH_MOVE_TO_PATTERN = /^\*\*\*\s+Move to:\s+(.+)$/;
const APPLY_PATCH_BEGIN_PATTERN = /^\*\*\*\s+Begin Patch$/;
const APPLY_PATCH_END_PATTERN = /^\*\*\*\s+End Patch$/;
const APPLY_PATCH_EOF_PATTERN = /^\*\*\*\s+End of File$/;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const normalizePatchText = (patch: string): string => {
    return patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
};

const normalizeBareUnifiedHeaderLines = (patch: string): string => {
    let reachedHunk = false;
    return patch.split('\n').map((line) => {
        if (line.startsWith('@@')) {
            reachedHunk = true;
            return line;
        }

        if (reachedHunk) {
            return line;
        }

        const headerMatch = line.match(/^\s*(---|\+\+\+)\s+(.+)$/);
        if (!headerMatch) {
            return line;
        }

        const marker = headerMatch[1];
        const rawPath = headerMatch[2] ?? '';
        if (rawPath.trim() === '/dev/null') {
            return `${marker} /dev/null`;
        }

        return `${marker} ${rawPath.replace(/\\/g, '/')}`;
    }).join('\n');
};

const normalizeLooseUnifiedHunkBody = (patch: string): string => {
    let inHunk = false;
    return patch.split('\n').map((line) => {
        if (line.startsWith('@@')) {
            inHunk = true;
            return line;
        }

        if (!inHunk || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff --git')) {
            return line;
        }

        if (line.length === 0) {
            return ' ';
        }

        const first = line[0];
        if (first === ' ' || first === '+' || first === '-' || first === '\\') {
            return line;
        }

        return ` ${line}`;
    }).join('\n');
};

const formatHunkRange = (start: string, count: number): string => {
    return count === 1 ? start : `${start},${count}`;
};

const recountUnifiedHunkHeaders = (patch: string): string => {
    const lines = patch.split('\n');
    const result = [...lines];

    for (let index = 0; index < lines.length; index += 1) {
        const header = lines[index] ?? '';
        const match = header.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
        if (!match) {
            continue;
        }

        let oldCount = 0;
        let newCount = 0;
        for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
            const line = lines[bodyIndex] ?? '';
            if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('diff --git')) {
                break;
            }

            if (line.startsWith('\\')) {
                continue;
            }

            if (line.startsWith('+')) {
                newCount += 1;
                continue;
            }

            if (line.startsWith('-')) {
                oldCount += 1;
                continue;
            }

            oldCount += 1;
            newCount += 1;
        }

        result[index] = `@@ -${formatHunkRange(match[1] ?? '0', oldCount)} +${formatHunkRange(match[2] ?? '0', newCount)} @@${match[3] ?? ''}`;
    }

    return result.join('\n');
};

const normalizeLooseUnifiedPatch = (patch: string): string => {
    return recountUnifiedHunkHeaders(normalizeLooseUnifiedHunkBody(normalizeBareUnifiedHeaderLines(normalizePatchText(patch))));
};

export const getPatchText = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
        return /\S/.test(value) ? value : undefined;
    }

    if (isRecord(value)) {
        const patch = value.patch;
        if (typeof patch === 'string') {
            return /\S/.test(patch) ? patch : undefined;
        }
    }

    return undefined;
};

const normalizeParsedPath = (path: string | undefined): string => {
    const trimmed = (path ?? '').trim().replace(/\t.*$/, '');
    if (!trimmed || trimmed === '/dev/null') {
        return '';
    }
    return trimmed.replace(/^[ab]\//, '');
};

const makeSyntheticPath = (title: string): string => {
    const normalized = title.trim().replace(/\s+/g, '-');
    return normalized.length > 0 ? normalized : 'file';
};

type ApplyPatchAction = 'add' | 'update' | 'delete';

type ApplyPatchFile = {
    action: ApplyPatchAction;
    oldPath: string;
    newPath: string;
    lines: string[];
};

type ApplyPatchHunk = {
    header?: string;
    section?: string;
    lines: string[];
};

const normalizeApplyPatchPath = (path: string): string => {
    const normalized = path.trim().replace(/\\/g, '/').replace(/^[ab]\//, '').replace(/^\/+/, '');
    return normalized.length > 0 ? normalized : 'file';
};

const diffPath = (prefix: 'a' | 'b', path: string): string => {
    const normalized = normalizeApplyPatchPath(path);
    return `${prefix}/${normalized}`;
};

const parseApplyPatchEnvelope = (patch: string): ApplyPatchFile[] | null => {
    const files: ApplyPatchFile[] = [];
    let current: ApplyPatchFile | null = null;
    let sawEnvelope = false;

    const finishCurrent = () => {
        if (!current) {
            return;
        }
        files.push(current);
        current = null;
    };

    for (const line of patch.split('\n')) {
        if (APPLY_PATCH_BEGIN_PATTERN.test(line)) {
            sawEnvelope = true;
            continue;
        }

        if (APPLY_PATCH_END_PATTERN.test(line)) {
            sawEnvelope = true;
            finishCurrent();
            break;
        }

        const fileHeader = line.match(APPLY_PATCH_FILE_HEADER_PATTERN);
        if (fileHeader) {
            sawEnvelope = true;
            finishCurrent();

            const actionText = fileHeader[1];
            const path = fileHeader[2]?.trim() ?? '';
            const action: ApplyPatchAction = actionText === 'Add File'
                ? 'add'
                : actionText === 'Delete File'
                    ? 'delete'
                    : 'update';

            current = {
                action,
                oldPath: path,
                newPath: path,
                lines: [],
            };
            continue;
        }

        const moveTo = line.match(APPLY_PATCH_MOVE_TO_PATTERN);
        if (moveTo && current) {
            sawEnvelope = true;
            current.newPath = moveTo[1]?.trim() || current.newPath;
            continue;
        }

        if (APPLY_PATCH_EOF_PATTERN.test(line)) {
            sawEnvelope = true;
            continue;
        }

        if (current) {
            current.lines.push(line);
        }
    }

    finishCurrent();

    return sawEnvelope ? files : null;
};

const isDiffBodyLine = (line: string): boolean => {
    if (line.length === 0) {
        return false;
    }

    const marker = line[0];
    return marker === ' ' || marker === '+' || marker === '-' || marker === '\\';
};

const formatRange = (start: number, count: number): string => {
    return count === 1 ? String(start) : `${start},${count}`;
};

const countOldLines = (lines: string[]): number =>
    lines.reduce((count, line) => count + (line.startsWith(' ') || line.startsWith('-') ? 1 : 0), 0);

const countNewLines = (lines: string[]): number =>
    lines.reduce((count, line) => count + (line.startsWith(' ') || line.startsWith('+') ? 1 : 0), 0);

const buildApplyPatchUpdateHunks = (lines: string[]): string[] => {
    const hunks: string[] = [];
    let current: ApplyPatchHunk | null = null;
    let oldCursor = 1;
    let newCursor = 1;

    const flushCurrent = () => {
        if (!current || current.lines.length === 0) {
            current = null;
            return;
        }

        const oldLineCount = countOldLines(current.lines);
        const newLineCount = countNewLines(current.lines);
        const header = current.header
            ?? `@@ -${formatRange(oldCursor, oldLineCount)} +${formatRange(newCursor, newLineCount)} @@${current.section ? ` ${current.section}` : ''}`;

        hunks.push([header, ...current.lines].join('\n'));
        oldCursor += Math.max(oldLineCount, 1);
        newCursor += Math.max(newLineCount, 1);
        current = null;
    };

    for (const line of lines) {
        if (line.startsWith('*** ')) {
            continue;
        }

        if (line.startsWith('@@')) {
            flushCurrent();
            current = HUNK_HEADER_PATTERN.test(line)
                ? { header: line, lines: [] }
                : { section: line.replace(/^@@\s*/, '').trim(), lines: [] };
            continue;
        }

        if (!isDiffBodyLine(line)) {
            continue;
        }

        current ??= { lines: [] };
        current.lines.push(line);
    }

    flushCurrent();
    return hunks;
};

const buildApplyPatchFileDiff = (file: ApplyPatchFile): { patch: string; title: string } | null => {
    const oldPath = normalizeApplyPatchPath(file.oldPath);
    const newPath = normalizeApplyPatchPath(file.newPath || file.oldPath);
    const title = file.action === 'delete' ? oldPath : newPath;

    if (file.action === 'add') {
        const addedLines = file.lines.filter((line) => line.startsWith('+'));
        if (addedLines.length === 0) {
            return null;
        }

        return {
            title,
            patch: [
                '--- /dev/null',
                `+++ ${diffPath('b', newPath)}`,
                `@@ -0,0 +${formatRange(1, addedLines.length)} @@`,
                ...addedLines,
            ].join('\n'),
        };
    }

    if (file.action === 'delete') {
        const removedLines = file.lines.filter((line) => line.startsWith('-'));
        if (removedLines.length === 0) {
            return null;
        }

        return {
            title,
            patch: [
                `--- ${diffPath('a', oldPath)}`,
                '+++ /dev/null',
                `@@ -${formatRange(1, removedLines.length)} +0,0 @@`,
                ...removedLines,
            ].join('\n'),
        };
    }

    const hunks = buildApplyPatchUpdateHunks(file.lines);
    if (hunks.length === 0) {
        return null;
    }

    return {
        title,
        patch: [
            `--- ${diffPath('a', oldPath)}`,
            `+++ ${diffPath('b', newPath)}`,
            ...hunks,
        ].join('\n'),
    };
};

const hasOnlyUnifiedDiffBodyLines = (patch: string): boolean => {
    let inHunk = false;
    for (const line of patch.split('\n')) {
        if (line.startsWith('@@')) {
            if (!HUNK_HEADER_PATTERN.test(line)) {
                return false;
            }
            inHunk = true;
            continue;
        }

        if (!inHunk || line.length === 0) {
            continue;
        }

        const first = line[0];
        if (first !== ' ' && first !== '+' && first !== '-' && first !== '\\') {
            return false;
        }
    }

    return true;
};

export const getRenderablePatchInfo = (patch: string): { patch: string; title?: string } | null => {
    const normalized = normalizeLooseUnifiedPatch(patch);
    if (
        !normalized
        || APPLY_PATCH_ENVELOPE_PATTERN.test(normalized)
        || !HUNK_HEADER_PATTERN.test(normalized)
        || !hasOnlyUnifiedDiffBodyLines(normalized)
    ) {
        return null;
    }

    try {
        const parsedPatches = parsePatchFiles(normalized, undefined, true);
        if (parsedPatches.length !== 1) {
            return null;
        }

        const files = parsedPatches[0]?.files ?? [];
        const file = files[0];
        if (files.length !== 1 || !file || file.hunks.length === 0) {
            return null;
        }

        return {
            patch: normalized,
            title: normalizeParsedPath(file.name),
        };
    } catch {
        return null;
    }
};

const getPatchChunks = (patch: string): string[] => {
    const isGitDiff = GIT_DIFF_FILE_BREAK_TEST.test(patch);
    const hasUnifiedDiff = UNIFIED_DIFF_FILE_BREAK_TEST.test(patch);
    if (!isGitDiff && !hasUnifiedDiff) {
        return [];
    }

    return patch
        .split(isGitDiff ? GIT_DIFF_FILE_BREAK_PATTERN : UNIFIED_DIFF_FILE_BREAK_PATTERN)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0);
};

const getPatchEntriesFromText = (
    patch: string,
    fallbackTitle: string,
    idPrefix: string,
    resolveTitle: (path: string) => string,
): DiffPatchEntry[] => {
    const envelopeNormalized = normalizePatchText(patch);
    if (!envelopeNormalized) {
        return [];
    }

    // Parse apply_patch envelopes before normalizing loose unified hunks.
    // Hunk normalization prefixes unknown lines with a context marker, which
    // would turn `*** End Patch` into a rendered line and inflate hunk counts.
    if (APPLY_PATCH_ENVELOPE_PATTERN.test(envelopeNormalized)) {
        const files = parseApplyPatchEnvelope(envelopeNormalized);
        const entries: DiffPatchEntry[] = [];

        for (const file of files ?? []) {
            const built = buildApplyPatchFileDiff(file);
            if (!built) {
                continue;
            }

            const info = getRenderablePatchInfo(built.patch);
            if (!info) {
                continue;
            }

            entries.push({
                id: `${idPrefix}-${entries.length}`,
                title: resolveTitle(info.title || built.title || fallbackTitle),
                patch: info.patch,
                renderMode: 'diff',
            });
        }

        if (entries.length > 0) {
            return entries;
        }
    }

    const normalized = normalizeLooseUnifiedPatch(patch);

    const direct = getRenderablePatchInfo(normalized);
    if (direct) {
        const title = direct.title ? resolveTitle(direct.title) : resolveTitle(fallbackTitle);
        return [{ id: `${idPrefix}-0`, title, patch: direct.patch, renderMode: 'diff' }];
    }

    const chunkEntries: DiffPatchEntry[] = [];
    for (const chunk of getPatchChunks(normalized)) {
        const info = getRenderablePatchInfo(chunk);
        const title = info?.title ? resolveTitle(info.title) : resolveTitle(fallbackTitle);
        if (!info) {
            if (HUNK_HEADER_PATTERN.test(chunk) || GIT_DIFF_FILE_BREAK_TEST.test(chunk) || UNIFIED_DIFF_FILE_BREAK_TEST.test(chunk)) {
                chunkEntries.push({
                    id: `${idPrefix}-${chunkEntries.length}`,
                    title,
                    patch: chunk,
                    renderMode: 'text',
                });
            }
            continue;
        }
        chunkEntries.push({
            id: `${idPrefix}-${chunkEntries.length}`,
            title,
            patch: info.patch,
            renderMode: 'diff',
        });
    }

    if (chunkEntries.length > 0) {
        return chunkEntries;
    }

    if (!APPLY_PATCH_ENVELOPE_PATTERN.test(normalized) && HUNK_HEADER_PATTERN.test(normalized)) {
        const syntheticPath = makeSyntheticPath(fallbackTitle);
        const synthetic = getRenderablePatchInfo(`--- ${syntheticPath}\n+++ ${syntheticPath}\n${normalized}`);
        if (synthetic) {
            return [{
                id: `${idPrefix}-0`,
                title: resolveTitle(fallbackTitle),
                patch: synthetic.patch,
                renderMode: 'diff',
            }];
        }
    }

    return [{
        id: `${idPrefix}-0`,
        title: resolveTitle(fallbackTitle),
        patch: normalized,
        renderMode: 'text',
    }];
};

const getFilePatch = (file: unknown): { patch: string; title: string } | null => {
    if (!isRecord(file)) {
        return null;
    }

    const patch = getPatchText(file.patch) ?? getPatchText(file.diff);
    if (!patch) {
        return null;
    }

    const rawPath = typeof file.relativePath === 'string'
        ? file.relativePath
        : typeof file.filePath === 'string'
            ? file.filePath
            : '';

    return {
        patch,
        title: rawPath,
    };
};

export const getDiffPatchEntries = (
    metadata: Record<string, unknown> | undefined,
    fallbackDiff: string | undefined,
    resolveTitle: (path: string) => string,
): DiffPatchEntry[] => {
    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    const fileEntries = files.flatMap((file, index) => {
        const filePatch = getFilePatch(file);
        if (!filePatch) {
            return [];
        }
        return getPatchEntriesFromText(
            filePatch.patch,
            filePatch.title || `File ${index + 1}`,
            `file-${index}`,
            resolveTitle,
        );
    });

    if (fileEntries.length > 0) {
        return fileEntries;
    }

    const diff = typeof fallbackDiff === 'string' ? fallbackDiff : '';
    return getPatchEntriesFromText(diff, 'Diff', 'fallback', resolveTitle);
};
