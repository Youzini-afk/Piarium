import React from 'react';
import type { SessionSnapshot, SessionWorkspaceBinding } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { subscribePiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
import { listPiPackages } from '@/lib/pi-runtime/packages';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  loadPermissionSystemQuickMode,
  isPermissionSystemPackageInstalled,
  savePermissionSystemQuickMode,
  type PermissionSystemQuickModeState,
} from './permissionSystemQuickMode';
import {
  parsePermissionSystemStatus,
  PERMISSION_SYSTEM_STATUS_CHANNEL,
} from './permissionSystemStatus';

interface PermissionSystemComposerControlProps {
  cwd?: string;
  footerIconButtonClass?: string;
  sessionId?: string | null;
  snapshot?: SessionSnapshot;
  workspace?: SessionWorkspaceBinding;
}

export const PermissionSystemComposerControl: React.FC<PermissionSystemComposerControlProps> = ({
  cwd,
  footerIconButtonClass,
  sessionId,
  snapshot,
  workspace,
}) => {
  const { t } = useI18n();
  const [quickMode, setQuickMode] = React.useState<PermissionSystemQuickModeState | null>(null);
  const [quickModeError, setQuickModeError] = React.useState<string | null>(null);
  const [quickModeLoading, setQuickModeLoading] = React.useState(false);
  const [quickModeSaving, setQuickModeSaving] = React.useState(false);
  const [draftPackageAvailable, setDraftPackageAvailable] = React.useState<boolean | undefined>();
  const [modeRefreshRevision, setModeRefreshRevision] = React.useState(0);
  const [packageRevision, setPackageRevision] = React.useState(0);
  const modeGenerationRef = React.useRef(0);
  const modeTargetRef = React.useRef('');
  const rawStatus = usePiSessionStore((state) => (
    sessionId ? state.records[sessionId]?.extensionStates[PERMISSION_SYSTEM_STATUS_CHANNEL] : undefined
  ));
  const status = React.useMemo(() => parsePermissionSystemStatus(rawStatus), [rawStatus]);
  const permissionAvailable = sessionId ? status !== null : draftPackageAvailable === true;
  const preferProject = (workspace ?? snapshot?.workspace)?.kind === 'workspace';
  const modeTarget = `${getRuntimeKey()}:${sessionId ? `session:${sessionId}` : `cwd:${cwd ?? ''}`}:${preferProject ? 'project' : 'global'}`;
  modeTargetRef.current = modeTarget;

  React.useEffect(() => subscribePiRuntimeCatalogChanged((reason) => {
    if (reason === 'package') setPackageRevision((revision) => revision + 1);
    if (reason === 'plugin-config' || reason === 'reload') {
      setModeRefreshRevision((revision) => revision + 1);
    }
  }), []);

  React.useEffect(() => {
    if (sessionId) {
      setDraftPackageAvailable(undefined);
      return;
    }
    if (!cwd) {
      setDraftPackageAvailable(false);
      return;
    }
    let active = true;
    setDraftPackageAvailable(undefined);
    void listPiPackages({ cwd }).then((packages) => {
      if (active) setDraftPackageAvailable(isPermissionSystemPackageInstalled(packages));
    }).catch(() => {
      if (active) setDraftPackageAvailable(false);
    });
    return () => { active = false; };
  }, [cwd, packageRevision, sessionId]);

  React.useEffect(() => {
    const generation = ++modeGenerationRef.current;
    const target = sessionId ? { sessionId } as const : cwd ? { cwd } as const : null;
    if (!permissionAvailable || !target) {
      setQuickMode(null);
      setQuickModeError(null);
      setQuickModeLoading(false);
      setQuickModeSaving(false);
      return;
    }
    const actionTarget = modeTarget;
    setQuickModeLoading(true);
    setQuickModeError(null);
    void loadPermissionSystemQuickMode(target, preferProject).then((state) => {
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
  }, [cwd, modeRefreshRevision, modeTarget, permissionAvailable, preferProject, sessionId]);

  const toggleQuickMode = React.useCallback(async (): Promise<void> => {
    const target = sessionId ? { sessionId } as const : cwd ? { cwd } as const : null;
    if (!target || !quickMode || quickModeSaving) return;
    const actionTarget = modeTargetRef.current;
    const nextMode = quickMode.mode === 'auto' ? 'ask' : 'auto';
    setQuickModeSaving(true);
    setQuickModeError(null);
    try {
      const next = await savePermissionSystemQuickMode(target, quickMode, nextMode);
      if (modeTargetRef.current === actionTarget) setQuickMode(next);
    } catch (error) {
      if (modeTargetRef.current !== actionTarget) return;
      const message = error instanceof Error ? error.message : String(error);
      setQuickModeError(message);
      toast.error(t('settings.common.status.saveFailed'), { description: message });
    } finally {
      if (modeTargetRef.current === actionTarget) setQuickModeSaving(false);
    }
  }, [cwd, quickMode, quickModeSaving, sessionId, t]);

  if (!permissionAvailable) return null;

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
  const pending = (status?.pending.length ?? 0) > 0;

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
