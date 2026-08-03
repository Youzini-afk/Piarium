import React from 'react';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { ExtensionStatusPresentation } from './extensionPresentation';

interface PiExtensionStatusCardProps {
  className?: string;
  messageId: string;
  status: ExtensionStatusPresentation;
}

export const PiExtensionStatusCard: React.FC<PiExtensionStatusCardProps> = ({
  className,
  messageId,
  status,
}) => (
  <article
    className={cn(
      'w-full rounded-lg border bg-muted/15 px-3 py-2',
      status.level === 'error' && 'border-[var(--status-error)]/40',
      status.level === 'warning' && 'border-[var(--status-warning)]/40',
      status.level === 'success' && 'border-[var(--status-success)]/40',
      status.level === 'info' && 'border-border/60',
      className,
    )}
    style={{ contentVisibility: 'auto' }}
  >
    <div className="mb-1 flex items-center gap-2 typography-ui-label text-foreground">
      <Icon
        name={status.level === 'error' || status.level === 'warning'
          ? 'error-warning'
          : status.level === 'success'
            ? 'check'
            : 'information'}
        className={cn(
          'size-3.5',
          status.level === 'error' && 'text-[var(--status-error)]',
          status.level === 'warning' && 'text-[var(--status-warning)]',
          status.level === 'success' && 'text-[var(--status-success)]',
        )}
      />
      <span>{status.title}</span>
    </div>
    <MarkdownRenderer
      content={status.text}
      messageId={messageId}
      variant="tool"
      enableFileReferences
    />
    {status.details !== undefined ? (
      <details className="group/details mt-2">
        <summary className="cursor-pointer select-none typography-micro text-muted-foreground hover:text-foreground">
          raw details
        </summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">
          {JSON.stringify(status.details, null, 2)}
        </pre>
      </details>
    ) : null}
  </article>
);
