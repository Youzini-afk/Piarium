import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  type PiWorkingIndicator,
  usePiInteractionStore,
} from '@/stores/usePiInteractionStore';

interface PiExtensionUiChromeProps {
  placement: 'aboveEditor' | 'belowEditor';
  sessionId: string;
}

const WorkingGlyph: React.FC<{ indicator?: PiWorkingIndicator }> = ({ indicator }) => {
  const frames = indicator?.frames;
  const [frameIndex, setFrameIndex] = React.useState(0);

  React.useEffect(() => {
    setFrameIndex(0);
    if (!frames || frames.length < 2) return;
    const interval = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
    }, indicator?.intervalMs ?? 80);
    return () => window.clearInterval(interval);
  }, [frames, indicator?.intervalMs]);

  if (frames?.length === 0) return null;
  if (frames) {
    return <span className="w-4 shrink-0 text-center font-mono">{frames[frameIndex]}</span>;
  }
  return <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-primary" />;
};

export const PiExtensionUiChrome: React.FC<PiExtensionUiChromeProps> = ({
  placement,
  sessionId,
}) => {
  const { t } = useI18n();
  const sessionUi = usePiInteractionStore((state) => state.sessions[sessionId]);
  if (!sessionUi) return null;

  const widgets = Object.entries(sessionUi.widgets)
    .filter(([, widget]) => widget.placement === placement);
  const statuses = Object.entries(sessionUi.statuses)
    // The maintained MCP adapter already has a first-class header popover.
    // Its Pi TUI footer string is not a second chat-composer control.
    .filter(([key]) => key !== 'mcp');
  const showWorking = placement === 'aboveEditor'
    && sessionUi.workingVisible !== false
    && (
      sessionUi.workingVisible === true
      || sessionUi.workingMessage !== undefined
      || sessionUi.workingIndicator !== undefined
    );
  const showStatus = placement === 'aboveEditor' && statuses.length > 0;
  if (widgets.length === 0 && !showWorking && !showStatus) return null;

  return (
    <div
      className={cn(
        'shrink-0 px-3 sm:px-5',
        placement === 'aboveEditor' ? 'pt-2' : 'pb-2',
      )}
    >
      <div className="mx-auto w-full max-w-4xl space-y-2">
        {showWorking && (
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 typography-meta text-muted-foreground">
            <WorkingGlyph indicator={sessionUi.workingIndicator} />
            <span className="min-w-0 flex-1 truncate">
              {sessionUi.workingMessage ?? t('agentManager.detail.dialog.working')}
            </span>
          </div>
        )}
        {showStatus && (
          <div className="flex flex-wrap gap-2">
            {statuses.map(([key, text]) => (
              <span
                key={key}
                title={key}
                className="max-w-full truncate rounded-md border border-border/60 bg-muted/20 px-2 py-1 typography-micro text-muted-foreground"
              >
                {text}
              </span>
            ))}
          </div>
        )}
        {widgets.map(([key, widget]) => (
          <pre
            key={key}
            data-pi-extension-widget={key}
            className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/20 px-3 py-2 font-mono typography-micro text-foreground"
          >
            {widget.lines.join('\n')}
          </pre>
        ))}
      </div>
    </div>
  );
};
