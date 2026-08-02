import React from 'react';
import type { ImageAttachment, SessionSnapshot } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { FollowUpBehavior } from '@/stores/messageQueueStore';
import { useUIStore } from '@/stores/useUIStore';
import { projectPiSessionActivity } from '@/lib/pi-runtime/sessionActivity';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';

interface PiComposerProps {
  draft: string;
  followUpBehavior: FollowUpBehavior;
  images: ImageAttachment[];
  onAbort(): Promise<void> | void;
  onChangeDraft(value: string): void;
  onChangeImages(value: ImageAttachment[]): void;
  onSend(): Promise<void> | void;
  onSendText(value: string): Promise<void> | void;
  sending: boolean;
  snapshot: SessionSnapshot;
}

const attachmentUrl = (attachment: ImageAttachment): string => (
  `data:${attachment.mimeType};base64,${attachment.data}`
);

const fileToAttachment = (file: File): Promise<ImageAttachment> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
  reader.onload = () => {
    const value = typeof reader.result === 'string' ? reader.result : '';
    const separator = value.indexOf(',');
    if (separator === -1) {
      reject(new Error(`Could not decode ${file.name}`));
      return;
    }
    resolve({
      data: value.slice(separator + 1),
      mimeType: file.type || 'application/octet-stream',
    });
  };
  reader.readAsDataURL(file);
});

export const PiComposer: React.FC<PiComposerProps> = ({
  draft,
  followUpBehavior,
  images,
  onAbort,
  onChangeDraft,
  onChangeImages,
  onSend,
  onSendText,
  sending,
  snapshot,
}) => {
  const { t } = useI18n();
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const composingRef = React.useRef(false);
  const isMobile = useUIStore((state) => state.isMobile);
  const isExpandedInput = useUIStore((state) => state.isExpandedInput);
  const toggleExpandedInput = useUIStore((state) => state.toggleExpandedInput);
  const busy = projectPiSessionActivity(snapshot).isWorking;
  const canSend = draft.trim().length > 0 || images.length > 0;
  const footerIconButtonClass = 'flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';

  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);

  const addFiles = React.useCallback(async (files: Iterable<File>) => {
    const imageFiles = [...files].filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    try {
      const attachments = await Promise.all(imageFiles.map(fileToAttachment));
      onChangeImages([...images, ...attachments]);
    } catch (error) {
      console.error('Failed to attach image to Pi prompt:', error);
      toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.attachFileFailed'));
    }
  }, [images, onChangeImages, t]);

  const queue = [...snapshot.steering, ...snapshot.followUp];

  const insertTranscript = React.useCallback((text: string) => {
    const next = [draft.trimEnd(), text.trim()]
      .filter((value) => value.length > 0)
      .join('\n');
    onChangeDraft(next);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [draft, onChangeDraft]);

  return (
    <div className={cn(
      'shrink-0 border-t border-border bg-background px-3 pb-[max(0.75rem,var(--oc-safe-area-bottom,0px))] pt-3 sm:px-5',
      isExpandedInput && 'fixed inset-0 z-40 flex items-end bg-background/95',
    )}>
      <div className={cn('mx-auto w-full max-w-4xl', isExpandedInput && 'flex h-full flex-col justify-end py-6')}>
        {queue.length > 0 && (
          <details className="mb-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <summary className="cursor-pointer select-none typography-meta text-muted-foreground">
              {t('chat.queuedMessage.title')} · {queue.length}
            </summary>
            <ol className="mt-2 space-y-1 border-t border-border/60 pt-2">
              {queue.map((message, index) => (
                <li key={`${index}:${message}`} className="whitespace-pre-wrap break-words typography-meta text-foreground">
                  {message || t('chat.queuedMessage.empty')}
                </li>
              ))}
            </ol>
          </details>
        )}

        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((image, index) => (
              <div key={`${image.mimeType}:${index}`} className="group/image relative overflow-hidden rounded-lg border border-border bg-muted/20">
                <img src={attachmentUrl(image)} alt={image.mimeType} className="size-20 object-cover" />
                <button
                  type="button"
                  onClick={() => onChangeImages(images.filter((_, candidate) => candidate !== index))}
                  className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover/image:opacity-100 focus:opacity-100"
                  aria-label="Remove image"
                >
                  <Icon name="close" className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className={cn(
            'relative rounded-xl border border-border bg-muted/15 transition-colors focus-within:border-primary/50',
            sending && 'opacity-80',
          )}
          onDragOver={(event) => {
            if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) event.preventDefault();
          }}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files];
            if (files.length === 0) return;
            event.preventDefault();
            void addFiles(files);
          }}
        >
          <textarea
            ref={inputRef}
            data-pi-chat-input="true"
            value={draft}
            onChange={(event) => onChangeDraft(event.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (!files.some((file) => file.type.startsWith('image/'))) return;
              event.preventDefault();
              void addFiles(files);
            }}
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter'
                || event.shiftKey
                || composingRef.current
                || event.nativeEvent.isComposing
              ) return;
              event.preventDefault();
              if (canSend && !sending) void onSend();
            }}
            placeholder={t('chat.chatInput.placeholder.chat')}
            className={cn(
              'block min-h-20 w-full resize-none overflow-y-auto bg-transparent px-3 pb-2 pt-3 typography-ui-label text-foreground outline-none placeholder:text-muted-foreground/70',
              isExpandedInput ? 'max-h-[70vh] min-h-[40vh]' : 'max-h-[40vh]',
            )}
          />

          <div data-chat-input-footer="true" className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 items-center gap-1">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = event.target.files;
                  if (files) void addFiles(files);
                  event.target.value = '';
                }}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                    aria-label={t('chat.chatInput.actions.addAttachment')}
                  >
                    <Icon name="attachment-2" className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t('chat.chatInput.actions.attachFiles')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggleExpandedInput}
                    className={footerIconButtonClass}
                    aria-label={isExpandedInput ? 'Exit expanded editor' : 'Expand editor'}
                  >
                    <Icon name={isExpandedInput ? 'fullscreen-exit' : 'fullscreen'} className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isExpandedInput ? 'Exit expanded editor' : 'Expand editor'}
                </TooltipContent>
              </Tooltip>
              <ComposerDictation
                disabled={sending}
                footerIconButtonClass={footerIconButtonClass}
                footerPaddingClass="px-2 pb-2"
                iconSizeClass="size-4"
                isMobile={isMobile}
                onInsert={insertTranscript}
                onInsertAndSend={onSendText}
                radius="0.75rem"
                sendIconSizeClass="size-4"
              />
              {busy && (
                <span className="truncate px-1 typography-micro text-muted-foreground">
                  {followUpBehavior === 'queue' ? 'Queue follow-up' : 'Steer current run'}
                </span>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {busy && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => void onAbort()}
                      className="flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                      aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
                    >
                      <Icon name="stop" className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t('chat.chatInput.actions.stopGeneratingAria')}</TooltipContent>
                </Tooltip>
              )}
              <button
                type="button"
                onClick={() => void onSend()}
                disabled={!canSend || sending}
                className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={t('chat.chatInput.actions.sendMessageAria')}
              >
                <Icon name={sending ? 'loader-4' : 'arrow-up'} className={cn('size-4', sending && 'animate-spin')} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
