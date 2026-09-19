import React from 'react';
import type { ExperimentArtifactView, ExperimentAttemptView, ResourceGpuView, ResourceMachineView } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { useHarnessThreadState } from '@/components/pi-session/HarnessThreadStateContext';
import { subscribePiariumEvents } from '@/lib/piariumEvents';
import { useI18n } from '@/lib/i18n';
import {
  cancelResearchAttempt,
  collectResearchAttempt,
  loadResearchArtifact,
  loadResearchAttemptDetails,
  loadResearchAttemptLogs,
  loadResearchFacts,
  type ResearchAttemptDetails,
  type ResearchFactsSnapshot,
} from './researchFacts';

const ACTIVE_STATES = new Set(['submitted', 'queued', 'running', 'stopping']);
const COLLECTABLE = new Set(['completed', 'failed', 'cancelled']);

const formatResources = (resources: { cpuCores?: number; memoryMb?: number; gpus?: ResourceGpuView[] } | undefined): string => {
  if (!resources) return '';
  const parts: string[] = [];
  if (resources.cpuCores !== undefined) parts.push(`${resources.cpuCores} cpu`);
  if (resources.memoryMb !== undefined) parts.push(`${Math.round(resources.memoryMb / 1024)} GiB`);
  if (resources.gpus && resources.gpus.length > 0) {
    parts.push(`${resources.gpus.length} gpu`);
  }
  return parts.join(' ');
};

const formatGpuDetails = (gpus: ResourceGpuView[] | undefined): string => {
  if (!gpus || gpus.length === 0) return '';
  return gpus.map((gpu, index) => {
    const label = gpu.name ?? `#${index + 1}`;
    const memory = gpu.memoryMb !== undefined ? ` ${Math.round(gpu.memoryMb / 1024)} GiB` : '';
    const utilization = gpu.utilizationPercent !== undefined ? ` ${Math.round(gpu.utilizationPercent)}%` : '';
    return `${label}${memory}${utilization}`;
  }).join(', ');
};

const formatObservedAt = (value: number | undefined): string => (
  value === undefined ? '' : new Date(value).toISOString()
);

const MachineRow: React.FC<{ machine: ResourceMachineView }> = ({ machine }) => {
  const { t } = useI18n();
  const capacity = machine.capacity
    ? formatResources(machine.capacity)
    : '';
  const usage = machine.usage
    ? `${machine.usage.cpuPercent !== undefined ? `${Math.round(machine.usage.cpuPercent)}% cpu ` : ''}${machine.usage.memoryMb !== undefined ? `${Math.round(machine.usage.memoryMb / 1024)} GiB` : ''}`.trim()
    : '';
  const capacityGpus = formatGpuDetails(machine.capacity?.gpus);
  const usageGpus = formatGpuDetails(machine.usage?.gpus);
  return (
    <li className="py-1">
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">{machine.label ?? machine.machineId}</span>
        <span className="text-muted-foreground">{machine.kind}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {t(`research-facts.machine.${machine.state}`)} · {t(`research-facts.connection.${machine.connection.status}`)}
        </span>
      </div>
      <div className="mt-0.5 text-muted-foreground">
        {capacity ? `${t('research-facts.capacity')}: ${capacity}` : t('research-facts.capacityUnknown')}
        {capacityGpus ? ` · ${capacityGpus}` : ''}
        {' · '}
        {usage ? `${t('research-facts.usage')}: ${usage}` : t('research-facts.usageUnread')}
        {usageGpus ? ` · ${usageGpus}` : ''}
        {machine.usage?.source ? ` · ${t('research-facts.source')}: ${machine.usage.source}` : ''}
        {machine.usage?.observedAt !== undefined ? ` · ${t('research-facts.observedAt', { time: formatObservedAt(machine.usage.observedAt) })}` : ''}
        {machine.usage?.stale ? ` · ${t('research-facts.stale')}` : ''}
        {machine.connection.checkedAt !== undefined ? ` · ${t('research-facts.checkedAt', { time: formatObservedAt(machine.connection.checkedAt) })}` : ''}
        {machine.commitments.length > 0 ? ` · ${t('research-facts.commitments', { count: machine.commitments.length })}` : ''}
      </div>
      {machine.queued.length > 0 ? (
        <div className="mt-0.5 text-muted-foreground">
          {t('research-facts.queued')}: {machine.queued.map((entry) => entry.attemptId).join(', ')}
        </div>
      ) : null}
    </li>
  );
};

const AttemptRow: React.FC<{
  attempt: ExperimentAttemptView;
  busy: boolean;
  selected: boolean;
  onAction: (attemptId: string, action: 'cancel' | 'collect') => void;
  onSelect: (attemptId: string) => void;
}> = ({ attempt, busy, selected, onAction, onSelect }) => {
  const { t } = useI18n();
  const attemptState = attempt.state as string;
  const active = ACTIVE_STATES.has(attemptState);
  const collectable = COLLECTABLE.has(attemptState) && (attempt.collection === 'none' || attempt.collection === 'failed');
  const attemptLabel = attemptState === 'unknown'
    ? t('research-facts.attempt.unknown')
    : t(`research-facts.attempt.${attemptState as ExperimentAttemptView['state']}`);
  return (
    <li className="py-1">
      <div className="flex items-center gap-2">
        <Icon
          name={active ? 'loader-4' : attemptState === 'completed' ? 'checkbox-circle' : attemptState === 'unknown' ? 'question' : 'alert'}
          className={`size-3.5 shrink-0 ${active ? 'animate-spin' : ''}`}
        />
        <span className="min-w-0 flex-1 truncate text-foreground" title={attempt.attemptId}>
          {attempt.attemptId}
        </span>
        <span className="shrink-0 text-muted-foreground">{attemptLabel}</span>
        {active ? (
          <button type="button" disabled={busy}
            className="shrink-0 text-primary hover:underline disabled:opacity-50"
            onClick={() => onAction(attempt.attemptId, 'cancel')}>
            {t('research-facts.cancel')}
          </button>
        ) : null}
        {collectable ? (
          <button type="button" disabled={busy}
            className="shrink-0 text-primary hover:underline disabled:opacity-50"
            onClick={() => onAction(attempt.attemptId, 'collect')}>
            {t('research-facts.collect')}
          </button>
        ) : null}
        <button type="button" className="shrink-0 text-primary hover:underline"
          aria-expanded={selected}
          onClick={() => onSelect(attempt.attemptId)}>
          {t(selected ? 'research-facts.hideDetails' : 'research-facts.viewDetails')}
        </button>
      </div>
      <div className="mt-0.5 text-muted-foreground">
        {attempt.machineId ?? 'local'}
        {attempt.exitCode !== undefined && attempt.exitCode !== null ? ` · exit ${attempt.exitCode}` : ''}
        {attempt.error ? ` · ${attempt.error}` : ''}
        {attempt.queueReason ? ` · ${attempt.queueReason}` : ''}
        {attempt.collection !== 'none' ? ` · ${t(`research-facts.collection.${attempt.collection}`)}` : ''}
      </div>
    </li>
  );
};

type LogStream = 'stdout' | 'stderr';
const DETAILS_UNAVAILABLE = 'details-unavailable';
type LogState = {
  text: string;
  nextOffset: number;
  eof: boolean;
  loaded: boolean;
  loading: boolean;
  error: string | null;
};

const emptyLog = (): LogState => ({ text: '', nextOffset: 0, eof: false, loaded: false, loading: false, error: null });

const ArtifactRow: React.FC<{
  sessionId: string;
  attemptId: string;
  artifact: ExperimentArtifactView;
}> = ({ sessionId, attemptId, artifact }) => {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await loadResearchArtifact(sessionId, attemptId, artifact.artifactId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = artifact.name.split(/[\\/]/).pop() || 'artifact';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center gap-2 py-1">
      <span className="min-w-0 flex-1 truncate text-foreground" title={artifact.name}>{artifact.name}</span>
      <span className="text-muted-foreground">{artifact.kind} · {artifact.state}</span>
      {artifact.byteLength !== undefined ? <span className="text-muted-foreground">{artifact.byteLength} B</span> : null}
      {artifact.state === 'available' ? (
        <button type="button" disabled={busy} className="shrink-0 text-primary hover:underline disabled:opacity-50" onClick={() => { void download(); }}>
          {t('research-facts.download')}
        </button>
      ) : <span className="text-muted-foreground">{t('research-facts.artifactUnavailable')}</span>}
      {error ? <span role="alert" className="text-muted-foreground">{error}</span> : null}
    </li>
  );
};

const AttemptDetails: React.FC<{
  sessionId: string;
  attemptId: string;
  attemptState: string;
  collection: string;
  initialArtifacts?: ExperimentArtifactView[];
}> = ({ sessionId, attemptId, attemptState, collection, initialArtifacts = [] }) => {
  const { t } = useI18n();
  const [details, setDetails] = React.useState<ResearchAttemptDetails | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [logs, setLogs] = React.useState<Record<LogStream, LogState>>({ stdout: emptyLog(), stderr: emptyLog() });
  const controllerRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setDetails(null);
    setError(null);
    setLogs({ stdout: emptyLog(), stderr: emptyLog() });
    void loadResearchAttemptDetails(sessionId, attemptId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        if (next) setDetails(next);
        else setError(DETAILS_UNAVAILABLE);
      })
      .catch((loadError) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    return () => controller.abort();
  }, [attemptId, attemptState, collection, sessionId]);

  const loadLog = React.useCallback(async (stream: LogStream, append: boolean) => {
    const current = logs[stream];
    if (current.loading) return;
    const controller = controllerRef.current;
    if (!controller || controller.signal.aborted) return;
    setLogs((previous) => ({ ...previous, [stream]: { ...previous[stream], loading: true, error: null } }));
    try {
      const result = await loadResearchAttemptLogs(sessionId, attemptId, {
        stream,
        offset: append ? current.nextOffset : 0,
        maxBytes: 4096,
      }, controller.signal);
      if (controller.signal.aborted || controllerRef.current !== controller) return;
      if (!result) throw new Error(t('research-facts.noLog'));
      setLogs((previous) => ({
        ...previous,
        [stream]: {
          text: append ? previous[stream].text + result.text : result.text,
          nextOffset: result.nextOffset,
          eof: result.eof,
          loaded: true,
          loading: false,
          error: null,
        },
      }));
    } catch (loadError) {
      if (controller.signal.aborted || controllerRef.current !== controller) return;
      setLogs((previous) => ({
        ...previous,
        [stream]: { ...previous[stream], loading: false, error: loadError instanceof Error ? loadError.message : String(loadError) },
      }));
    }
  }, [attemptId, logs, sessionId, t]);

  const renderLog = (stream: LogStream) => {
    const log = logs[stream];
    return (
      <div key={stream} className="mt-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{t(`research-facts.log.${stream}`)}</span>
          <button type="button" disabled={log.loading} className="text-primary hover:underline disabled:opacity-50"
            onClick={() => { void loadLog(stream, log.loaded); }}>
            {t(log.loaded && !log.eof ? 'research-facts.loadMore' : 'research-facts.loadLog')}
          </button>
        </div>
        {log.text ? <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs">{log.text}</pre> : log.loaded ? <p className="mt-1 text-muted-foreground">{t('research-facts.noLog')}</p> : null}
        {log.error ? <p role="alert" className="mt-1 text-muted-foreground">{log.error}</p> : null}
      </div>
    );
  };

  const artifacts = initialArtifacts.length > 0 ? initialArtifacts : (details?.artifacts ?? []);
  return (
    <div className="mt-2 border-l border-border/60 pl-3" data-testid={`research-attempt-details-${attemptId}`}>
      {error ? <p role="alert" className="text-muted-foreground">
        {error === DETAILS_UNAVAILABLE ? t('research-facts.detailsUnavailable') : `${t('research-facts.detailsUnavailable')} ${error}`}
      </p> : null}
      {!error && !details ? <p className="text-muted-foreground">{t('research-facts.loadingDetails')}</p> : null}
      {details || initialArtifacts.length > 0 ? (
        <>
          <section aria-label={t('research-facts.logs')}>
            <h5 className="typography-ui-label text-foreground">{t('research-facts.logs')}</h5>
            {renderLog('stdout')}
            {renderLog('stderr')}
          </section>
          <section className="mt-3" aria-label={t('research-facts.artifacts')}>
            <h5 className="typography-ui-label text-foreground">{t('research-facts.artifacts')}</h5>
            {artifacts.length > 0 ? (
              <ul className="mt-1 divide-y divide-border/40">
                {artifacts.map((artifact) => <ArtifactRow key={artifact.artifactId} sessionId={sessionId} attemptId={attemptId} artifact={artifact} />)}
              </ul>
            ) : <p className="mt-1 text-muted-foreground">{t('research-facts.noArtifacts')}</p>}
          </section>
        </>
      ) : null}
    </div>
  );
};

/**
 * Experiment/resource/source facts for the session's owning workspace (7F).
 * Facts come from the harness services through session-scoped routes; a
 * `harness-experiment-changed` event or stream reconnect triggers a reload.
 */
export const ResearchFactsPanel: React.FC = () => {
  const { t } = useI18n();
  const { parent, workspaceId } = useHarnessThreadState();
  const sessionId = parent.kind === 'session' ? parent.id : null;
  const [facts, setFacts] = React.useState<ResearchFactsSnapshot | null>(null);
  const [loadError, setLoadError] = React.useState<{ message: string; refresh: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [selectedAttemptId, setSelectedAttemptId] = React.useState<string | null>(null);
  const [collectedArtifacts, setCollectedArtifacts] = React.useState<Record<string, ExperimentArtifactView[]>>({});
  const activeSessionRef = React.useRef<string | null>(sessionId);
  const reloadRef = React.useRef<{ epoch: number; controller: AbortController | null }>({ epoch: 0, controller: null });
  activeSessionRef.current = sessionId;

  const invalidateReload = React.useCallback(() => {
    reloadRef.current.epoch += 1;
    reloadRef.current.controller?.abort();
    reloadRef.current.controller = null;
  }, []);

  const reload = React.useCallback(async () => {
    if (!sessionId) return;
    reloadRef.current.controller?.abort();
    const controller = new AbortController();
    const epoch = ++reloadRef.current.epoch;
    reloadRef.current.controller = controller;
    try {
      const snapshot = await loadResearchFacts(sessionId, controller.signal);
      if (controller.signal.aborted || reloadRef.current.epoch !== epoch || activeSessionRef.current !== sessionId) return;
      if (snapshot) {
        setFacts(snapshot);
        setLoadError(null);
      } else {
        setFacts(null);
        setLoadError(null);
      }
    } catch (error) {
      if (controller.signal.aborted || reloadRef.current.epoch !== epoch || activeSessionRef.current !== sessionId) return;
      setLoadError({ message: error instanceof Error ? error.message : String(error), refresh: true });
    } finally {
      if (reloadRef.current.epoch === epoch) reloadRef.current.controller = null;
    }
  }, [sessionId]);

  React.useEffect(() => {
    invalidateReload();
    setFacts(null);
    setLoadError(null);
    setBusy(false);
    setSelectedAttemptId(null);
    setCollectedArtifacts({});
    if (!sessionId || !workspaceId) return () => invalidateReload();
    void reload();
    const unsubscribe = subscribePiariumEvents((event) => {
      if (event.type === 'stream-ready') {
        void reload();
        return;
      }
      if (event.type === 'harness-experiment-changed' && event.workspaceId === workspaceId) {
        void reload();
      }
    });
    return () => {
      invalidateReload();
      unsubscribe();
    };
  }, [invalidateReload, reload, sessionId, workspaceId]);

  const onAction = React.useCallback((attemptId: string, action: 'cancel' | 'collect') => {
    if (!sessionId) return;
    const actionSessionId = sessionId;
    setBusy(true);
    void (async () => {
      try {
        const result = action === 'collect'
          ? await collectResearchAttempt(actionSessionId, attemptId)
          : null;
        if (action === 'cancel') await cancelResearchAttempt(actionSessionId, attemptId);
        if (activeSessionRef.current !== actionSessionId) return;
        if (result && result.artifacts.length > 0) {
          setCollectedArtifacts((previous) => ({ ...previous, [attemptId]: result.artifacts }));
        }
        await reload();
      } catch (error) {
        if (activeSessionRef.current === actionSessionId) {
          setLoadError({ message: error instanceof Error ? error.message : String(error), refresh: false });
        }
      } finally {
        if (activeSessionRef.current === actionSessionId) setBusy(false);
      }
    })();
  }, [reload, sessionId]);

  if (!sessionId || !workspaceId) return null;
  if (!facts && !loadError) return null;

  const attempts = facts?.attempts ?? [];
  const machines = facts?.machines ?? [];
  const sources = facts?.sources ?? [];

  return (
    <details className="mt-2 typography-meta" data-testid="research-facts-panel">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        {t('research-facts.summary', {
          attempts: attempts.length,
          machines: machines.length,
          sources: sources.length,
        })}
      </summary>
      {loadError ? (
        <div role="alert" className="mt-2 flex items-center gap-3">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {loadError.refresh ? `${t('research-facts.refreshFailed')} ` : ''}{loadError.message}
          </span>
          <button type="button" className="shrink-0 text-primary hover:underline"
            onClick={() => { void reload(); }}>
            {t('research-workbench.retry')}
          </button>
        </div>
      ) : null}
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <section aria-label={t('research-facts.attempts')}>
          <h4 className="typography-ui-label text-foreground">{t('research-facts.attempts')}</h4>
          {attempts.length === 0 ? (
            <p className="mt-1 text-muted-foreground">{t('research-facts.emptyAttempts')}</p>
          ) : (
            <ul className="mt-1 divide-y divide-border/40">
              {attempts.map((attempt) => (
                <React.Fragment key={attempt.attemptId}>
                  <AttemptRow
                    attempt={attempt}
                    busy={busy}
                    selected={selectedAttemptId === attempt.attemptId}
                    onAction={onAction}
                    onSelect={(attemptId) => setSelectedAttemptId((current) => current === attemptId ? null : attemptId)}
                  />
                  {selectedAttemptId === attempt.attemptId ? (
                    <AttemptDetails
                      sessionId={sessionId}
                      attemptId={attempt.attemptId}
                      attemptState={attempt.state}
                      collection={attempt.collection}
                      initialArtifacts={collectedArtifacts[attempt.attemptId]}
                    />
                  ) : null}
                </React.Fragment>
              ))}
            </ul>
          )}
        </section>
        <section aria-label={t('research-facts.machines')}>
          <h4 className="typography-ui-label text-foreground">{t('research-facts.machines')}</h4>
          {machines.length === 0 ? (
            <p className="mt-1 text-muted-foreground">{t('research-facts.emptyMachines')}</p>
          ) : (
            <ul className="mt-1 divide-y divide-border/40">
              {machines.map((machine) => <MachineRow key={machine.machineId} machine={machine} />)}
            </ul>
          )}
          {sources.length > 0 ? (
            <>
              <h4 className="mt-3 typography-ui-label text-foreground">{t('research-facts.sources')}</h4>
              <ul className="mt-1 divide-y divide-border/40">
                {sources.map((source) => (
                  <li key={source.sourceId} className="py-1 text-muted-foreground">
                    <span className="text-foreground">{source.label ?? source.sourceId}</span>
                    {' · '}{source.kind}{' · '}{source.uri ?? source.path ?? source.objectHash ?? ''}
                    {source.state === 'retired' ? ` (${t('research-facts.sourceRetired')})` : ''}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      </div>
    </details>
  );
};
