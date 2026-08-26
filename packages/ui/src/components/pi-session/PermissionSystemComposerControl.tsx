import React from 'react';
import type { SessionSnapshot } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  loadPermissionSystemQuickMode,
  savePermissionSystemQuickMode,
  type PermissionSystemQuickModeState,
} from './permissionSystemQuickMode';
import {
  parsePermissionSystemStatus,
  PERMISSION_SYSTEM_STATUS_CHANNEL,
} from './permissionSystemStatus';

interface PermissionSystemComposerControlProps {
  footerIconButtonClass?: string;
  sessionId?: string | null;
  snapshot?: SessionSnapshot;
}

export const PermissionSystemComposerControl: React.FC<PermissionSystemComposerControlProps> = ({
  footerIconButtonClass,
  sessionId,
  snapshot,
}) => {
  const { t } = useI18n();
  const [quickMode, setQuickMode] = React.useState<PermissionSystemQuickModeState | null>(null);
  const [quickModeError, setQuickModeError] = React.useState<string | null>(null);
  const [quickModeLoading, setQuickModeLoading] = React.useState(false);
  const [quickModeSaving, setQuickModeSaving] = React.useState(false);
  const modeGenerationRef = React.useRef(0);
  const modeTargetRef = React.useRef('');
  const rawStatus = usePiSessionStore((state) => (
    sessionId ? state.records[sessionId]?.extensionStates[PERMISSION_SYSTEM_STATUS_CHANNEL] : undefined
  ));
  const status = React.useMemo(() => parsePermissionSystemStatus(rawStatus), [rawStatus]);
  const permissionAvailable = status !== null;
  const preferProject = snapshot?.workspace?.kind === 'workspace';
  const modeTarget = `${getRuntimeKey()}:${sessionId ?? ''}:${preferProject ? 'project' : 'global'}`;
  modeTargetRef.current = modeTarget;

  React.useEffect(() => {
    const generation = ++modeGenerationRef.current;
    if (!permissionAvailable || !sessionId) {
      setQuickMode(null);
      setQuickModeError(null);
      setQuickModeLoading(false);
      setQuickModeSaving(false);
      return;
    }
    const actionTarget = modeTarget;
    setQuickModeLoading(true);
    setQuickModeError(null);
    void loadPermissionSystemQuickMode({ sessionId }, preferProject).then((state) => {
      if (generation !== modeGenerationRef.current || modeTargetRef.current !== actionTarget) return;
      setQuickMode(state);
    }).catch((error) => {
      if (generation !== modeGenerationRef.current || modeTargetRef.current !== actionTarget) return;
      setQuickMode(null);
      setQuickModeError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (generation === modeGenerationRef.current && modeTargetRef.current === actionTarget) {
        setQuickModeLoading(false);
      }
    });
  }, [modeTarget, permissionAvailable, preferProject, sessionId]);

  const toggleQuickMode = React.useCallback(async (): Promise<void> => {
    if (!sessionId || !quickMode || quickModeSaving) return;
    const actionTarget = modeTargetRef.current;
    const nextMode = quickMode.mode === 'auto' ? 'ask' : 'auto';
    setQuickModeSaving(true);
    setQuickModeError(null);
    try {
      const next = await savePermissionSystemQuickMode({ sessionId }, quickMode, nextMode);
      if (modeTargetRef.current === actionTarget) setQuickMode(next);
    } catch (error) {
      if (modeTargetRef.current !== actionTarget) return;
      const message = error instanceof Error ? error.message : String(error);
      setQuickModeError(message);
      toast.error(t('settings.common.status.saveFailed'), { description: message });
    } finally {
      if (modeTargetRef.current === actionTarget) setQuickModeSaving(false);
    }
  }, [quickMode, quickModeSaving, sessionId, t]);

  if (!status) return null;

  const autoAccept = quickMode?.mode === 'auto';
  const interactive = quickMode !== null && !quickModeLoading && !quickModeSaving;
  const ariaLabel = autoAccept
    ? t('chat.chatInput.permissionAutoAccept.disable')
    : t('chat.chatInput.permissionAutoAccept.enable');
  const tooltipLabel = autoAccept
    ? t('chat.chatInput.permissionAutoAccept.on')
    : t('chat.chatInput.permissionAutoAccept.off');
  const scopeLabel = quickMode?.scope === 'project'
    ? t('settings.common.scope.project')
    : t('settings.common.scope.global');
  const pending = status.pending.length > 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void toggleQuickMode()}
          className={cn(
            footerIconButtonClass,
            'relative rounded-md hover:bg-transparent',
            !interactive && 'opacity-30',
          )}
          onMouseDown={(event) => event.preventDefault()}
          onPointerDownCapture={(event) => {
            if (event.pointerType === 'touch') {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          aria-disabled={!interactive}
          aria-pressed={autoAccept}
          aria-label={ariaLabel}
        >
          <Icon
            name={quickModeSaving ? 'loader-4' : autoAccept ? 'shield-check' : 'shield-user'}
            className={cn('size-4', quickModeSaving && 'animate-spin')}
            style={autoAccept ? { color: 'var(--status-info)' } : undefined}
          />
          {pending ? (
            <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-[var(--status-warning)]" />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        <div>{quickModeError ?? tooltipLabel}</div>
        {quickMode ? <div className="opacity-70">{scopeLabel}</div> : null}
      </TooltipContent>
    </Tooltip>
  );
};
