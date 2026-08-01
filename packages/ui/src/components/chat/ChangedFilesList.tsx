import React from 'react';
import {
    RiArrowGoBackLine,
    RiFileTextLine,
    RiGitPullRequestLine,
    RiLoader4Line,
} from '@remixicon/react';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
    type ChangedFileEntry,
    getDisplayPath,
    getFileStats,
    getGitChangeKind,
    isGitFile,
} from './changedFiles';
import { useI18n } from '@/lib/i18n';

interface ChangedFilesListProps {
    files: ChangedFileEntry[];
    currentDirectory: string;
    onOpenFile?: (file: ChangedFileEntry) => void;
    onViewDiff?: (file: ChangedFileEntry) => void;
    onRevertFile?: (file: ChangedFileEntry) => void;
    revertingPaths?: ReadonlySet<string>;
}

const actionButtonClassName = [
    'flex size-6 shrink-0 items-center justify-center rounded-md',
    'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
    'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

const statusColorByKind = {
    created: 'var(--status-success)',
    deleted: 'var(--status-error)',
    modified: 'var(--status-warning)',
    renamed: 'var(--status-info)',
    copied: 'var(--status-info)',
} as const;

const getStatusCode = (file: ChangedFileEntry): string | null => {
    if (!isGitFile(file)) return null;
    const code = file.status.trim().charAt(0);
    if (code) return code;
    return getGitChangeKind(file) === 'created' ? 'A' : 'M';
};

export const ChangedFilesList: React.FC<ChangedFilesListProps> = ({
    files,
    currentDirectory,
    onOpenFile,
    onViewDiff,
    onRevertFile,
    revertingPaths,
}) => {
    const { t } = useI18n();
    return (
        <>
            <div className="flex items-center gap-1.5 px-2 py-1 typography-ui-label font-medium text-muted-foreground">
                <span>{t('chat.changedFiles.title')}</span>
                <span className="typography-meta tabular-nums">{files.length}</span>
            </div>

            <div className="max-h-[260px] overflow-y-auto">
                {files.map((file, index) => {
                    const { fileName, dirPart } = getDisplayPath(file, currentDirectory);
                    const stats = getFileStats(file);
                    const statusCode = getStatusCode(file);
                    const statusKind = isGitFile(file) ? getGitChangeKind(file) : null;
                    const statusColor = statusKind ? statusColorByKind[statusKind] : undefined;
                    const fileKey = isGitFile(file) ? file.relativePath : file.path;
                    const isReverting = revertingPaths?.has(fileKey) ?? false;
                    const openTitle = t('chat.changedFiles.actions.openFileTitle', { path: fileKey });
                    const diffTitle = t('chat.changedFiles.actions.viewDiffTitle', { path: fileKey });
                    const revertTitle = t('chat.changedFiles.actions.revertFileTitle', { path: fileKey });
                    const primaryAction = onOpenFile ?? onViewDiff;

                    return (
                        <div
                            key={`${file.path}:${index}`}
                            className="group relative flex w-full items-center gap-1 rounded-lg px-1.5 py-1 typography-ui-label outline-hidden select-none hover:bg-interactive-hover"
                        >
                            <button
                                type="button"
                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-0.5 py-0.5 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
                                title={openTitle}
                                aria-label={openTitle}
                                disabled={!primaryAction}
                                onClick={() => primaryAction?.(file)}
                            >
                                {statusCode ? (
                                    <span
                                        className="w-3.5 shrink-0 text-center typography-micro font-semibold uppercase"
                                        style={{ color: statusColor }}
                                        aria-hidden="true"
                                    >
                                        {statusCode}
                                    </span>
                                ) : null}
                                <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 flex-shrink-0" />
                                <span className="min-w-0 flex-1 flex items-baseline overflow-hidden" title={fileKey}>
                                    {dirPart ? (
                                        <>
                                            <span
                                                className="min-w-0 truncate text-muted-foreground"
                                                style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                                            >
                                                {dirPart}
                                            </span>
                                            <span className="flex-shrink-0">
                                                <span className="text-muted-foreground">/</span>
                                                <span className="text-foreground">{fileName}</span>
                                            </span>
                                        </>
                                    ) : (
                                        <span className="truncate text-foreground">{fileName}</span>
                                    )}
                                </span>
                                {(stats.additions > 0 || stats.deletions > 0) ? (
                                    <span className="flex-shrink-0 inline-flex items-baseline gap-1 text-[0.75rem] tabular-nums">
                                        {stats.additions > 0 ? <span style={{ color: 'var(--status-success)' }}>+{stats.additions}</span> : null}
                                        {stats.deletions > 0 ? <span style={{ color: 'var(--status-error)' }}>-{stats.deletions}</span> : null}
                                    </span>
                                ) : null}
                            </button>
                            <div className="flex shrink-0 items-center gap-0.5">
                                {onOpenFile ? (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                type="button"
                                                className={actionButtonClassName}
                                                title={openTitle}
                                                aria-label={openTitle}
                                                onClick={() => onOpenFile(file)}
                                            >
                                                <RiFileTextLine className="size-3.5" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent sideOffset={8}>{t('chat.changedFiles.actions.openFile')}</TooltipContent>
                                    </Tooltip>
                                ) : null}
                                {onViewDiff ? (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                type="button"
                                                className={actionButtonClassName}
                                                title={diffTitle}
                                                aria-label={diffTitle}
                                                onClick={() => onViewDiff(file)}
                                            >
                                                <RiGitPullRequestLine className="size-3.5" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent sideOffset={8}>{t('chat.changedFiles.actions.viewDiff')}</TooltipContent>
                                    </Tooltip>
                                ) : null}
                                {onRevertFile ? (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                type="button"
                                                className={actionButtonClassName}
                                                title={revertTitle}
                                                aria-label={revertTitle}
                                                disabled={isReverting}
                                                onClick={() => onRevertFile(file)}
                                            >
                                                {isReverting ? (
                                                    <RiLoader4Line className="size-3.5 animate-spin" />
                                                ) : (
                                                    <RiArrowGoBackLine className="size-3.5" />
                                                )}
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent sideOffset={8}>{t('chat.changedFiles.actions.revertFile')}</TooltipContent>
                                    </Tooltip>
                                ) : null}
                            </div>
                        </div>
                    );
                })}
            </div>
        </>
    );
};
