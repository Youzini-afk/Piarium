/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import type {
  ProviderAuthEvent,
  ProviderAuthMethodDescriptor,
  ProviderAuthPrompt,
  ProviderAuthType,
} from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { loginPiProvider } from '@/lib/pi-runtime/providers';

export interface AuthLink {
  label?: string;
  url: string;
}

export interface AuthDetails {
  instructions?: string;
  links: AuthLink[];
  message?: string;
  userCode?: string;
}

export interface PendingProviderAuthPrompt {
  prompt: ProviderAuthPrompt;
  value: string;
}

export type ProviderAuthResult =
  | { status: 'authenticated' }
  | { status: 'cancelled' }
  | { error: unknown; status: 'failed' };

export interface ProviderAuthController {
  busy: ProviderAuthType | null;
  completePrompt(cancelled?: boolean): void;
  details: AuthDetails;
  pendingPrompt: PendingProviderAuthPrompt | null;
  setPromptValue(value: string): void;
  start(type: ProviderAuthType, options?: { seedSecret?: string }): Promise<ProviderAuthResult>;
  cancel(): void;
}

interface PendingPromptEntry {
  cleanup(): void;
  prompt: ProviderAuthPrompt;
  resolve(value: string | undefined): void;
  value: string;
}

interface ActiveAuthRun {
  cancelled: boolean;
  controller: AbortController;
  pending: Map<string, PendingPromptEntry>;
  runId: number;
  seedSecret?: string;
  seedUsed: boolean;
}

const promptDefaultValue = (): string => '';

export const getProviderAuthPromptInitialValue = (
  prompt: ProviderAuthPrompt,
  seedSecret: string | undefined,
  seedUsed: boolean,
): { seedUsed: boolean; value: string } => {
  if (prompt.type === 'secret' && seedSecret && !seedUsed) {
    return { seedUsed: true, value: seedSecret };
  }
  return { seedUsed, value: promptDefaultValue() };
};

export const detailsFromAuthEvent = (event: ProviderAuthEvent): Partial<AuthDetails> => {
  switch (event.type) {
    case 'auth_url':
      return {
        instructions: event.instructions,
        links: [{ url: event.url }],
      };
    case 'device_code':
      return {
        links: [{ url: event.verificationUri }],
        userCode: event.userCode,
      };
    case 'info':
      return {
        links: event.links ?? [],
        message: event.message,
      };
    case 'progress':
      return { message: event.message };
  }
};

const mergeAuthDetails = (current: AuthDetails, update: Partial<AuthDetails>): AuthDetails => {
  const links = update.links === undefined ? current.links : [...current.links];
  if (update.links !== undefined) {
    for (const link of update.links) {
      const existingIndex = links.findIndex((candidate) => candidate.url === link.url);
      if (existingIndex < 0) links.push(link);
      else links[existingIndex] = { ...links[existingIndex], ...link };
    }
  }
  return {
    ...current,
    ...update,
    links,
  };
};

const isCancellationError = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return (error as { code?: unknown }).code === 'auth_cancelled';
};

export const usePiProviderAuth = ({
  cwd,
  providerId,
}: {
  cwd: string;
  providerId: string;
}): ProviderAuthController => {
  const mountedRef = React.useRef(false);
  const runIdRef = React.useRef(0);
  const activeRunRef = React.useRef<ActiveAuthRun | null>(null);
  const currentPromptIdRef = React.useRef<string | null>(null);
  const target = React.useMemo(() => ({ cwd, providerId }), [cwd, providerId]);
  const targetRef = React.useRef(target);
  targetRef.current = target;
  const [authState, setAuthState] = React.useState<{
    busy: ProviderAuthType | null;
    details: AuthDetails;
    pendingPrompt: PendingProviderAuthPrompt | null;
  }>({
    busy: null,
    details: { links: [] },
    pendingPrompt: null,
  });

  const settlePrompt = React.useCallback((run: ActiveAuthRun, requestId: string, value: string | undefined) => {
    const pending = run.pending.get(requestId);
    if (!pending) return;
    run.pending.delete(requestId);
    pending.cleanup();
    if (currentPromptIdRef.current === requestId) {
      currentPromptIdRef.current = null;
      if (mountedRef.current && activeRunRef.current === run) {
        setAuthState((current) => ({ ...current, pendingPrompt: null }));
      }
    }
    pending.resolve(value);
  }, []);

  const cancel = React.useCallback(() => {
    const run = activeRunRef.current;
    if (!run) return;
    run.cancelled = true;
    run.controller.abort();
    for (const requestId of [...run.pending.keys()]) {
      settlePrompt(run, requestId, undefined);
    }
    if (mountedRef.current) {
      currentPromptIdRef.current = null;
      setAuthState((current) => ({ ...current, busy: null, pendingPrompt: null }));
    }
    if (activeRunRef.current === run) activeRunRef.current = null;
  }, [settlePrompt]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      cancel();
      mountedRef.current = false;
    };
  }, [cancel, cwd, providerId]);

  const start = React.useCallback(async (
    type: ProviderAuthType,
    options: { seedSecret?: string } = {},
  ): Promise<ProviderAuthResult> => {
    if (
      !mountedRef.current
      || targetRef.current !== target
      || activeRunRef.current
    ) return { status: 'cancelled' };

    const run: ActiveAuthRun = {
      cancelled: false,
      controller: new AbortController(),
      pending: new Map(),
      runId: ++runIdRef.current,
      ...(options.seedSecret?.trim() ? { seedSecret: options.seedSecret.trim() } : {}),
      seedUsed: false,
    };
    activeRunRef.current = run;
    currentPromptIdRef.current = null;
    if (mountedRef.current) {
      setAuthState({ busy: type, details: { links: [] }, pendingPrompt: null });
    }

    const isCurrentRun = () => (
      mountedRef.current
      && activeRunRef.current === run
      && run.runId === runIdRef.current
      && targetRef.current === target
      && !run.cancelled
    );

    const onPrompt = (prompt: ProviderAuthPrompt, promptSignal?: AbortSignal): Promise<string | undefined> => {
      if (!isCurrentRun() || run.controller.signal.aborted || promptSignal?.aborted) {
        return Promise.resolve(undefined);
      }

      return new Promise<string | undefined>((resolve) => {
        const cleanupHandlers: Array<() => void> = [];
        const initialValue = getProviderAuthPromptInitialValue(prompt, run.seedSecret, run.seedUsed);
        run.seedUsed = initialValue.seedUsed;
        const entry: PendingPromptEntry = {
          cleanup: () => {
            for (const cleanup of cleanupHandlers.splice(0)) cleanup();
          },
          prompt,
          resolve,
          value: initialValue.value,
        };
        const abortPrompt = () => settlePrompt(run, prompt.requestId, undefined);
        if (promptSignal) {
          promptSignal.addEventListener('abort', abortPrompt, { once: true });
          cleanupHandlers.push(() => promptSignal.removeEventListener('abort', abortPrompt));
        }
        const abortRun = () => settlePrompt(run, prompt.requestId, undefined);
        run.controller.signal.addEventListener('abort', abortRun, { once: true });
        cleanupHandlers.push(() => run.controller.signal.removeEventListener('abort', abortRun));
        run.pending.set(prompt.requestId, entry);
        currentPromptIdRef.current = prompt.requestId;
        setAuthState((current) => ({
          ...current,
          pendingPrompt: { prompt, value: entry.value },
        }));
      });
    };

    try {
      await loginPiProvider({
        cwd,
        onEvent: (event) => {
          if (!isCurrentRun()) return;
          const update = detailsFromAuthEvent(event);
          setAuthState((current) => ({
            ...current,
            details: mergeAuthDetails(current.details, update),
          }));
          if (event.type === 'auth_url') void openExternalUrl(event.url);
          if (event.type === 'device_code') void openExternalUrl(event.verificationUri);
        },
        onPrompt,
        providerId,
        signal: run.controller.signal,
        type,
      });
      if (!isCurrentRun() || run.cancelled || run.controller.signal.aborted) return { status: 'cancelled' };
      return { status: 'authenticated' };
    } catch (error) {
      if (!isCurrentRun() || run.cancelled || run.controller.signal.aborted || isCancellationError(error)) {
        return { status: 'cancelled' };
      }
      return { error, status: 'failed' };
    } finally {
      for (const requestId of [...run.pending.keys()]) {
        settlePrompt(run, requestId, undefined);
      }
      if (activeRunRef.current === run) {
        activeRunRef.current = null;
        currentPromptIdRef.current = null;
        if (mountedRef.current) {
          setAuthState((current) => ({ ...current, busy: null, pendingPrompt: null }));
        }
      }
    }
  }, [cwd, providerId, settlePrompt, target]);

  const setPromptValue = React.useCallback((value: string) => {
    const run = activeRunRef.current;
    const requestId = currentPromptIdRef.current;
    if (!run || !requestId) return;
    const pending = run.pending.get(requestId);
    if (!pending) return;
    pending.value = value;
    if (mountedRef.current) {
      setAuthState((current) => (
        current.pendingPrompt?.prompt.requestId === requestId
          ? { ...current, pendingPrompt: { ...current.pendingPrompt, value } }
          : current
      ));
    }
  }, []);

  const completePrompt = React.useCallback((cancelled = false) => {
    if (cancelled) {
      cancel();
      return;
    }
    const run = activeRunRef.current;
    const requestId = currentPromptIdRef.current;
    if (!run || !requestId) return;
    const pending = run.pending.get(requestId);
    if (!pending) return;
    settlePrompt(run, requestId, pending.value);
  }, [cancel, settlePrompt]);

  return {
    ...authState,
    cancel,
    completePrompt,
    setPromptValue,
    start,
  };
};

export const ProviderAuthPromptView: React.FC<{
  auth: Pick<ProviderAuthController, 'busy' | 'cancel' | 'completePrompt' | 'details' | 'pendingPrompt' | 'setPromptValue'>;
}> = ({ auth }) => {
  const { t } = useI18n();
  const promptInputId = React.useId();

  const copy = async (value: string, successKey: Parameters<typeof t>[0]) => {
    const result = await copyTextToClipboard(value);
    if (result.ok) toast.success(t(successKey));
    else toast.error(t('settings.providers.page.toast.oauthLinkCopyFailed'));
  };

  return (
    <div className="space-y-3">
      {(auth.details.instructions || auth.details.message) && (
        <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 rounded px-2 py-1.5">
          {auth.details.instructions && <span className="block">{auth.details.instructions}</span>}
          {auth.details.message && auth.details.message !== auth.details.instructions && (
            <span className="block">{auth.details.message}</span>
          )}
        </p>
      )}

      {auth.details.userCode && (
        <div className="flex items-center gap-2">
          <Input value={auth.details.userCode} readOnly className="font-mono text-center tracking-widest" />
          <Button
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() => void copy(auth.details.userCode ?? '', 'settings.providers.page.toast.deviceCodeCopied')}
          >
            {t('settings.providers.page.actions.copyCode')}
          </Button>
        </div>
      )}

      {auth.details.links.map((link) => (
        <div key={link.url} className="flex items-center gap-2">
          <Input value={link.url} readOnly className="text-xs text-muted-foreground" />
          <div className="flex shrink-0 gap-1">
            <Button variant="outline" size="xs" className="!font-normal" onClick={() => void openExternalUrl(link.url)}>
              {link.label || t('settings.providers.page.actions.open')}
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => void copy(link.url, 'settings.providers.page.toast.oauthLinkCopied')}
            >
              {t('settings.providers.page.actions.copy')}
            </Button>
          </div>
        </div>
      ))}

      {auth.pendingPrompt && (
        <div className="space-y-2 rounded-lg border border-[var(--surface-subtle)] p-3">
          <label htmlFor={promptInputId} className="typography-ui-label text-foreground">{auth.pendingPrompt.prompt.message}</label>
          {auth.pendingPrompt.prompt.type === 'select' ? (
            <Select
              value={auth.pendingPrompt.value}
              onValueChange={auth.setPromptValue}
            >
              <SelectTrigger id={promptInputId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {auth.pendingPrompt.prompt.options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    <div className="flex flex-col items-start">
                      <span>{option.label}</span>
                      {option.description && <span className="typography-micro text-muted-foreground">{option.description}</span>}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id={promptInputId}
              type={auth.pendingPrompt.prompt.type === 'secret' ? 'password' : 'text'}
              value={auth.pendingPrompt.value}
              onInput={(event) => auth.setPromptValue(event.currentTarget.value)}
              onChange={(event) => auth.setPromptValue(event.target.value)}
              placeholder={auth.pendingPrompt.prompt.placeholder}
              className="font-mono text-xs"
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  auth.completePrompt();
                }
              }}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="xs" className="!font-normal" onClick={() => auth.completePrompt(true)}>
              {t('settings.providers.page.actions.cancel')}
            </Button>
            <Button
              size="xs"
              className="!font-normal"
              onClick={() => auth.completePrompt()}
              disabled={auth.pendingPrompt.prompt.type === 'select'
                && !auth.pendingPrompt.prompt.options.some((option) => option.id === auth.pendingPrompt!.value)}
            >
              {t('settings.providers.page.actions.complete')}
            </Button>
          </div>
        </div>
      )}

      {auth.busy && !auth.pendingPrompt && (
        <div className="flex justify-end">
          <Button variant="outline" size="xs" className="!font-normal" onClick={auth.cancel}>
            {t('settings.providers.page.actions.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
};

export const ProviderAuthPanel: React.FC<{
  cwd: string;
  methods: ProviderAuthMethodDescriptor[];
  onAuthenticated(providerId: string): Promise<void> | void;
  providerId: string;
}> = ({ cwd, methods, onAuthenticated, providerId }) => {
  const { t } = useI18n();
  const auth = usePiProviderAuth({ cwd, providerId });

  const handleStart = async (method: ProviderAuthMethodDescriptor) => {
    const result = await auth.start(method.type);
    if (result.status === 'authenticated') {
      toast.success(
        method.type === 'api_key'
          ? t('settings.providers.page.toast.apiKeySaved')
          : t('settings.providers.page.toast.oauthCompleted'),
      );
      await onAuthenticated(providerId);
    } else if (result.status === 'failed') {
      console.error('Failed to authenticate Pi provider:', result.error);
      toast.error(
        method.type === 'api_key'
          ? t('settings.providers.page.toast.apiKeySaveFailed')
          : t('settings.providers.page.toast.oauthCompleteFailed'),
      );
    }
  };

  if (methods.length === 0) {
    return <p className="typography-meta text-muted-foreground py-1.5">{t('settings.providers.page.auth.connected')}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {methods.map((method) => (
          <Button
            key={method.type}
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() => void handleStart(method)}
            disabled={auth.busy !== null}
          >
            {auth.busy === method.type ? t('settings.providers.page.actions.saving') : method.label}
          </Button>
        ))}
      </div>
      {auth.busy && <ProviderAuthPromptView auth={auth} />}
    </div>
  );
};
