import React from 'react';
import type { HostHandshakeResult } from '@piarium/protocol';
import { Button } from '@/components/ui/button';
import { disconnectPiRuntime, getPiRuntimeConnection } from '@/lib/pi-runtime/client';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type RuntimeReadiness =
  | { kind: 'checking' }
  | { handshake: HostHandshakeResult; kind: 'ready' }
  | { kind: 'error'; message: string };

const RUNTIME_CHECK_TIMEOUT_MS = 15_000;

interface LocalPiRuntimeCardProps {
  onContinue: () => Promise<void> | void;
}

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export function LocalPiRuntimeCard({ onContinue }: LocalPiRuntimeCardProps) {
  const { t } = useI18n();
  const [readiness, setReadiness] = React.useState<RuntimeReadiness>({ kind: 'checking' });
  const [isContinuing, setIsContinuing] = React.useState(false);
  const checkGenerationRef = React.useRef(0);
  const mountedRef = React.useRef(true);

  const checkRuntime = React.useCallback(async () => {
    const generation = ++checkGenerationRef.current;
    setReadiness({ kind: 'checking' });
    let timeoutId: number | undefined;
    try {
      const connection = await Promise.race([
        getPiRuntimeConnection(),
        new Promise<never>((_resolve, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new Error(t('onboarding.localSetup.errors.timeout')));
          }, RUNTIME_CHECK_TIMEOUT_MS);
        }),
      ]);
      if (generation !== checkGenerationRef.current) return;
      setReadiness({ handshake: connection.handshake, kind: 'ready' });
    } catch (error) {
      if (generation !== checkGenerationRef.current) return;
      await disconnectPiRuntime();
      if (generation !== checkGenerationRef.current) return;
      setReadiness({ kind: 'error', message: errorMessage(error) });
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
  }, [t]);

  React.useEffect(() => {
    mountedRef.current = true;
    void checkRuntime();
    return () => {
      mountedRef.current = false;
      checkGenerationRef.current += 1;
    };
  }, [checkRuntime]);

  const handlePrimaryAction = React.useCallback(async () => {
    if (readiness.kind !== 'ready') {
      await checkRuntime();
      return;
    }
    setIsContinuing(true);
    try {
      await onContinue();
    } catch (error) {
      if (mountedRef.current) {
        setReadiness({ kind: 'error', message: errorMessage(error) });
      }
    } finally {
      if (mountedRef.current) setIsContinuing(false);
    }
  }, [checkRuntime, onContinue, readiness.kind]);

  const handshake = readiness.kind === 'ready' ? readiness.handshake : null;
  return (
    <div className="app-region-no-drag space-y-4">
      <div
        className={cn(
          'rounded-xl border px-4 py-4 text-left',
          readiness.kind === 'ready' && 'border-[var(--status-success)]/30 bg-[var(--status-success)]/5',
          readiness.kind === 'error' && 'border-destructive/40 bg-destructive/5',
          readiness.kind === 'checking' && 'border-border bg-background/50',
        )}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'mt-1.5 size-2.5 shrink-0 rounded-full',
              readiness.kind === 'ready' && 'bg-[var(--status-success)]',
              readiness.kind === 'error' && 'bg-destructive',
              readiness.kind === 'checking' && 'animate-pulse bg-primary',
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="typography-ui-label font-medium text-foreground">
              {readiness.kind === 'ready'
                ? t('onboarding.localSetup.status.ready')
                : readiness.kind === 'error'
                  ? t('onboarding.localSetup.status.failed')
                  : t('onboarding.localSetup.status.checking')}
            </p>
            <p className={cn(
              'break-words typography-meta',
              readiness.kind === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}>
              {readiness.kind === 'ready'
                ? t('onboarding.localSetup.status.readyDetail')
                : readiness.kind === 'error'
                  ? readiness.message
                  : t('onboarding.localSetup.status.checkingDetail')}
            </p>
          </div>
        </div>

        {handshake ? (
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/50 pt-3 typography-meta">
            <div>
              <dt className="text-muted-foreground">{t('onboarding.localSetup.runtime.piVersion')}</dt>
              <dd className="font-mono text-foreground">{handshake.runtime.piVersion}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('onboarding.localSetup.runtime.hostVersion')}</dt>
              <dd className="font-mono text-foreground">{handshake.hostVersion}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('onboarding.localSetup.runtime.nodeVersion')}</dt>
              <dd className="font-mono text-foreground">{handshake.runtime.nodeVersion}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('onboarding.localSetup.runtime.source')}</dt>
              <dd className="font-mono text-foreground">{handshake.runtime.source}</dd>
            </div>
          </dl>
        ) : null}
      </div>

      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={readiness.kind === 'checking' || isContinuing}
        onClick={() => void handlePrimaryAction()}
      >
        {readiness.kind === 'ready'
          ? isContinuing
            ? t('onboarding.localSetup.actions.continuing')
            : t('onboarding.localSetup.actions.continue')
          : readiness.kind === 'checking'
            ? t('onboarding.localSetup.actions.checking')
            : t('onboarding.localSetup.actions.retry')}
      </Button>
    </div>
  );
}
