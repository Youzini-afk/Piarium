import React from 'react';
import { RiAlignJustify, RiLayoutColumnLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export type DiffViewMode = 'side-by-side' | 'unified';

interface DiffViewToggleProps {
    mode: DiffViewMode;
    onModeChange: (mode: DiffViewMode) => void;
    className?: string;
}

export const DiffViewToggle: React.FC<DiffViewToggleProps> = ({ mode, onModeChange, className }) => {
    const { t } = useI18n();
    const handleClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            onModeChange(mode === 'side-by-side' ? 'unified' : 'side-by-side');
        },
        [mode, onModeChange]
    );

    return (
        <Button
            size="sm"
            variant="ghost"
            className={cn('h-5 w-5 p-0 opacity-60 hover:opacity-100', className)}
            onClick={handleClick}
            title={mode === 'side-by-side' ? t('chat.diffViewToggle.switchToUnified') : t('chat.diffViewToggle.switchToSideBySide')}
        >
            {mode === 'side-by-side' ? (
                <RiAlignJustify className="h-3 w-3" />
            ) : (
                <RiLayoutColumnLine className="h-3 w-3" />
            )}
        </Button>
    );
};
