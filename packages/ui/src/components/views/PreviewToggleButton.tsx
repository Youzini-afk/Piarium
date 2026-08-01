import React from 'react';

import { RiEyeLine, RiEyeOffLine } from '@remixicon/react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

export type PreviewToggleButtonProps = {
  /** Current mode - determines which icon is displayed */
  currentMode: 'preview' | 'edit';
  /** Callback fired when toggle button is clicked */
  onToggle: () => void;
};

/**
 * PreviewToggleButton - A toggle button for switching between preview and edit modes.
 *
 * Displays an eye icon when in preview mode (indicating the content is visible/read-only)
 * and a slashed eye icon when in edit mode (indicating the content can be edited).
 */
export const PreviewToggleButton: React.FC<PreviewToggleButtonProps> = ({
  currentMode,
  onToggle,
}) => {
  const { t } = useI18n();
  const isPreview = currentMode === 'preview';
  const ariaLabel = isPreview ? t('previewToggle.switchToEdit') : t('previewToggle.switchToPreview');
  const tooltipText = isPreview ? t('previewToggle.edit') : t('previewToggle.preview');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggle}
          aria-label={ariaLabel}
          className="h-5 w-5 p-0"
        >
          {isPreview ? (
            <RiEyeLine className="size-4" aria-hidden="true" />
          ) : (
            <RiEyeOffLine className="size-4" aria-hidden="true" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
};
