import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { usePiChatCatalog } from '@/components/chat/usePiChatCatalog';
import { Icon } from '@/components/icon/Icon';
import { PiExtensionStatusCard } from '@/components/pi-session/PiExtensionStatusCard';
import { SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { cn } from '@/lib/utils';
import {
  MAGIC_CONTEXT_DREAMER_TASK_DEFAULTS,
  type MagicContextDreamerTask,
} from './magic-context-config-model';
import {
  buildMagicContextRuntimeCommand,
  latestMagicContextStatus,
  type MagicContextRuntimeActionId,
  type MagicContextRuntimeCommandOptions,
} from './magic-context-runtime';

interface MagicContextRuntimePanelProps {
  runtimeTarget: RuntimeContextTarget;
}

type ConfirmedAction = Extract<MagicContextRuntimeActionId, 'dream' | 'session-upgrade' | 'wrapup'>;

const DREAM_TASKS = Object.keys(
  MAGIC_CONTEXT_DREAMER_TASK_DEFAULTS,
) as MagicContextDreamerTask[];

const actionCommandName = (
  action: MagicContextRuntimeActionId,
  options?: MagicContextRuntimeCommandOptions,
): string => buildMagicContextRuntimeCommand(action, options).command.split(' ', 1)[0] ?? '';

export const MagicContextRuntimePanel: React.FC<MagicContextRuntimePanelProps> = ({
  runtimeTarget,
}) => {
  const { t } = useI18n();
  const sessionId = 'sessionId' in runtimeTarget ? runtimeTarget.sessionId : null;
  const catalog = usePiChatCatalog({ sessionId, refreshOnMount: true });
  const executeCommand = usePiSessionStore((state) => state.executeCommand);
  const refreshEntries = usePiSessionStore((state) => state.refreshEntries);
  const sessionRecord = usePiSessionStore((state) => (
    sessionId ? state.records[sessionId] : undefined
  ));
  const [runningCommand, setRunningCommand] = React.useState<string | null>(null);
  const [confirmAction, setConfirmAction] = React.useState<ConfirmedAction | null>(null);
  const [messagesToKeepText, setMessagesToKeepText] = React.useState('20');
  const [dreamTask, setDreamTask] = React.useState<'all' | MagicContextDreamerTask>('all');
  const [augmentationPrompt, setAugmentationPrompt] = React.useState('');
  const [recompStartText, setRecompStartText] = React.useState('');
  const [recompEndText, setRecompEndText] = React.useState('');
  const commandNames = React.useMemo(
    () => new Set(catalog.commands.map((command) => command.name)),
    [catalog.commands],
  );
  const latestStatus = React.useMemo(
    () => latestMagicContextStatus(sessionRecord?.branchEntries?.entries),
    [sessionRecord?.branchEntries?.entries],
  );
  const sessionBusy = sessionRecord?.snapshot?.busy === true;
  const magicActive = sessionId !== null && commandNames.has('ctx-status');
  const messagesToKeep = Number(messagesToKeepText);
  const validMessagesToKeep = Number.isSafeInteger(messagesToKeep) && messagesToKeep > 0;
  const recompStart = Number(recompStartText);
  const recompEnd = Number(recompEndText);
  const validRecompRange = Number.isSafeInteger(recompStart)
    && Number.isSafeInteger(recompEnd)
    && recompStart >= 1
    && recompEnd >= recompStart;

  React.useEffect(() => {
    if (!sessionId || sessionRecord?.branchEntries) return;
    void refreshEntries(sessionId).catch(() => undefined);
  }, [refreshEntries, sessionId, sessionRecord?.branchEntries]);

  const commandAvailable = React.useCallback((
    action: MagicContextRuntimeActionId,
    options?: MagicContextRuntimeCommandOptions,
  ) => commandNames.has(actionCommandName(action, options)), [commandNames]);

  const runAction = React.useCallback(async (
    action: MagicContextRuntimeActionId,
    options?: MagicContextRuntimeCommandOptions,
  ): Promise<boolean> => {
    if (!sessionId || runningCommand || sessionBusy) return false;
    let command: string;
    try {
      command = buildMagicContextRuntimeCommand(action, options).command;
    } catch (error) {
      toast.error(t('settings.piarium.pluginSettings.magic.runtime.invalidArguments'), {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    setRunningCommand(command);
    try {
      await executeCommand(sessionId, `/${command}`);
      await refreshEntries(sessionId);
      return true;
    } catch (error) {
      toast.error(t('settings.piarium.pluginSettings.magic.runtime.commandFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setRunningCommand(null);
    }
  }, [executeCommand, refreshEntries, runningCommand, sessionBusy, sessionId, t]);

  const submitConfirmedAction = React.useCallback(() => {
    const action = confirmAction;
    if (!action) return;
    const options = action === 'wrapup'
      ? { messagesToKeep }
      : action === 'dream' && dreamTask !== 'all'
        ? { dreamTask }
        : undefined;
    setConfirmAction(null);
    void runAction(action, options);
  }, [confirmAction, dreamTask, messagesToKeep, runAction]);

  const actionsDisabled = !magicActive || sessionBusy || runningCommand !== null;
  const providerState = !sessionId
    ? 'unavailable'
    : catalog.loading && !catalog.loaded
      ? 'loading'
      : magicActive
        ? 'active'
        : 'unavailable';

  return (
    <div className="space-y-5 rounded-lg border border-border/60 px-4 py-4">
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="typography-settings-group-title text-foreground">
            {t('settings.piarium.pluginSettings.magic.runtime.title')}
          </h3>
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.pluginSettings.magic.runtime.description')}
          </p>
        </div>
        <span className={cn(
          'w-fit rounded-full border px-2 py-0.5 typography-micro',
          providerState === 'active'
            ? 'border-[var(--status-success)]/30 text-[var(--status-success)]'
            : 'border-border/60 text-muted-foreground',
        )}>
          {t(`settings.piarium.pluginSettings.magic.runtime.state.${providerState}`)}
        </span>
      </div>

      {!sessionId ? (
        <p className="rounded-md bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-muted-foreground">
          {t('settings.piarium.pluginSettings.magic.runtime.openSession')}
        </p>
      ) : catalog.error ? (
        <p className="break-words typography-meta text-[var(--status-error)]">{catalog.error}</p>
      ) : !magicActive && catalog.loaded ? (
        <p className="rounded-md bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-muted-foreground">
          {t('settings.piarium.pluginSettings.magic.runtime.notActive')}
        </p>
      ) : null}

      {runningCommand ? (
        <p className="flex items-center gap-2 rounded-md bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          {t('settings.piarium.pluginSettings.magic.runtime.running', { command: `/${runningCommand}` })}
        </p>
      ) : sessionBusy ? (
        <p className="rounded-md border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-3 py-2 typography-meta text-[var(--status-warning)]">
          {t('settings.piarium.pluginSettings.magic.runtime.busy')}
        </p>
      ) : null}

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.magic.runtime.session.title')}
        description={t('settings.piarium.pluginSettings.magic.runtime.session.description')}
        contentClassName="flex flex-wrap gap-2"
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled || !commandAvailable('status')}
          onClick={() => void runAction('status')}
        >
          {runningCommand === 'ctx-status' ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
          {t('settings.piarium.pluginSettings.magic.runtime.action.status')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled || !commandAvailable('flush')}
          onClick={() => void runAction('flush')}
        >
          {runningCommand === 'ctx-flush' ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
          {t('settings.piarium.pluginSettings.magic.runtime.action.flush')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled || !commandAvailable('embedding-status')}
          onClick={() => void runAction('embedding-status')}
        >
          {runningCommand === 'ctx-embed' ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
          {t('settings.piarium.pluginSettings.magic.runtime.action.embeddingStatus')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled || !commandAvailable('embedding-start')}
          onClick={() => void runAction('embedding-start')}
        >
          {t('settings.piarium.pluginSettings.magic.runtime.action.embeddingStart')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled || !commandAvailable('embedding-pause')}
          onClick={() => void runAction('embedding-pause')}
        >
          {t('settings.piarium.pluginSettings.magic.runtime.action.embeddingPause')}
        </Button>
      </SettingsControlGroup>

      <SettingsControlGroup
        className="border-t border-border/60 pt-5"
        title={t('settings.piarium.pluginSettings.magic.runtime.augmentation.title')}
        description={t('settings.piarium.pluginSettings.magic.runtime.augmentation.description')}
        contentClassName="space-y-3"
      >
        <div className="space-y-1.5">
          <label className="typography-settings-field-label text-foreground" htmlFor="magic-augmentation-prompt">
            {t('settings.piarium.pluginSettings.magic.runtime.augmentation.prompt')}
          </label>
          <Textarea
            id="magic-augmentation-prompt"
            value={augmentationPrompt}
            disabled={actionsDisabled}
            placeholder={t('settings.piarium.pluginSettings.magic.runtime.augmentation.placeholder')}
            onChange={(event) => setAugmentationPrompt(event.target.value)}
            className="min-h-24"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled || !augmentationPrompt.trim() || !commandAvailable('augment', { prompt: augmentationPrompt })}
          onClick={() => void runAction('augment', { prompt: augmentationPrompt })}
        >
          {t('settings.piarium.pluginSettings.magic.runtime.action.augment')}
        </Button>
      </SettingsControlGroup>

      <SettingsControlGroup
        className="border-t border-border/60 pt-5"
        title={t('settings.piarium.pluginSettings.magic.runtime.maintenance.title')}
        description={t('settings.piarium.pluginSettings.magic.runtime.maintenance.description')}
        contentClassName="space-y-4"
      >
        <div className="flex flex-col gap-2 @xl:flex-row @xl:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <label className="typography-settings-field-label text-foreground" htmlFor="magic-wrapup-tail">
              {t('settings.piarium.pluginSettings.magic.runtime.messagesToKeep')}
            </label>
            <Input
              id="magic-wrapup-tail"
              type="number"
              min={1}
              step={1}
              value={messagesToKeepText}
              disabled={runningCommand !== null}
              onChange={(event) => setMessagesToKeepText(event.target.value)}
              className="max-w-40"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={actionsDisabled || !validMessagesToKeep || !commandAvailable('wrapup', { messagesToKeep })}
            onClick={() => setConfirmAction('wrapup')}
          >
            {t('settings.piarium.pluginSettings.magic.runtime.action.wrapup')}
          </Button>
        </div>

        <div className="flex flex-col gap-2 @xl:flex-row @xl:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <label className="typography-settings-field-label text-foreground" htmlFor="magic-dream-task">
              {t('settings.piarium.pluginSettings.magic.runtime.dreamTask')}
            </label>
            <Select value={dreamTask} onValueChange={setDreamTask} disabled={runningCommand !== null}>
              <SelectTrigger id="magic-dream-task" size="settings" className="w-full max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t('settings.piarium.pluginSettings.magic.runtime.dreamAll')}
                </SelectItem>
                {DREAM_TASKS.map((task) => <SelectItem key={task} value={task}>{task}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={actionsDisabled || !commandAvailable('dream', dreamTask === 'all' ? undefined : { dreamTask })}
            onClick={() => setConfirmAction('dream')}
          >
            {t('settings.piarium.pluginSettings.magic.runtime.action.dream')}
          </Button>
        </div>

        <div className="flex flex-col gap-2 @xl:flex-row @xl:items-end">
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <label className="typography-settings-field-label text-foreground" htmlFor="magic-recomp-start">
                {t('settings.piarium.pluginSettings.magic.runtime.recompStart')}
              </label>
              <Input
                id="magic-recomp-start"
                type="number"
                min={1}
                step={1}
                value={recompStartText}
                disabled={runningCommand !== null}
                onChange={(event) => setRecompStartText(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="typography-settings-field-label text-foreground" htmlFor="magic-recomp-end">
                {t('settings.piarium.pluginSettings.magic.runtime.recompEnd')}
              </label>
              <Input
                id="magic-recomp-end"
                type="number"
                min={1}
                step={1}
                value={recompEndText}
                disabled={runningCommand !== null}
                onChange={(event) => setRecompEndText(event.target.value)}
              />
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={actionsDisabled || !validRecompRange || !commandAvailable('recomp', {
              recompRange: { end: recompEnd, start: recompStart },
            })}
            onClick={() => void runAction('recomp', {
              recompRange: { end: recompEnd, start: recompStart },
            })}
          >
            {t('settings.piarium.pluginSettings.magic.runtime.action.recompRange')}
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={actionsDisabled || !commandAvailable('recomp')}
            onClick={() => void runAction('recomp')}
          >
            {t('settings.piarium.pluginSettings.magic.runtime.action.recomp')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={actionsDisabled || !commandAvailable('session-upgrade')}
            onClick={() => setConfirmAction('session-upgrade')}
          >
            {t('settings.piarium.pluginSettings.magic.runtime.action.upgrade')}
          </Button>
        </div>
        <p className="typography-meta text-muted-foreground">
          {t('settings.piarium.pluginSettings.magic.runtime.recompConfirmation')}
        </p>
        <p className="typography-meta text-muted-foreground">
          {t('settings.piarium.pluginSettings.magic.runtime.longRunningNote')}
        </p>
      </SettingsControlGroup>

      <SettingsControlGroup
        className="border-t border-border/60 pt-5"
        title={t('settings.piarium.pluginSettings.magic.runtime.latest.title')}
        description={t('settings.piarium.pluginSettings.magic.runtime.latest.description')}
      >
        {latestStatus ? (
          <div className="space-y-2">
            <p className="typography-micro text-muted-foreground">
              {new Date(latestStatus.timestamp).toLocaleString()}
            </p>
            <PiExtensionStatusCard
              messageId={`magic-settings:${latestStatus.entryId}`}
              status={latestStatus.status}
            />
          </div>
        ) : (
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.pluginSettings.magic.runtime.latest.empty')}
          </p>
        )}
      </SettingsControlGroup>

      <Dialog open={confirmAction !== null} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmAction
                ? t(`settings.piarium.pluginSettings.magic.runtime.confirm.${confirmAction}.title`)
                : ''}
            </DialogTitle>
            <DialogDescription>
              {confirmAction
                ? t(`settings.piarium.pluginSettings.magic.runtime.confirm.${confirmAction}.description`)
                : ''}
            </DialogDescription>
          </DialogHeader>
          {confirmAction ? (
            <code className="block break-all rounded-md bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-foreground">
              /{buildMagicContextRuntimeCommand(confirmAction, confirmAction === 'wrapup'
                ? { messagesToKeep }
                : confirmAction === 'dream' && dreamTask !== 'all'
                  ? { dreamTask }
                  : undefined).command}
            </code>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmAction(null)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              type="button"
              disabled={actionsDisabled || (confirmAction === 'wrapup' && !validMessagesToKeep)}
              onClick={submitConfirmedAction}
            >
              {t('settings.piarium.pluginSettings.magic.runtime.confirm.run')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
