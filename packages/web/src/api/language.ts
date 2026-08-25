import type {
  LanguageServicesAPI,
  PiariumLanguageCodeAction,
  PiariumLanguageCommandRequest,
  PiariumLanguageColorInformation,
  PiariumLanguageColorPresentation,
  PiariumLanguageCompletionItem,
  PiariumLanguageDocumentHighlight,
  PiariumLanguageDocumentLink,
  PiariumLanguageDocumentSyncRequest,
  PiariumLanguageDocumentSyncResult,
  PiariumLanguageFeatureRequest,
  PiariumLanguageFeatureResult,
  PiariumLanguageLocation,
  PiariumLanguageLocationLink,
  PiariumLanguageFoldingRange,
  PiariumLanguageHover,
  PiariumLanguageInlayHint,
  PiariumLanguageProviderStatus,
  PiariumLanguageServiceEvent,
  PiariumLanguageSelectionRange,
  PiariumLanguageSemanticTokens,
  PiariumLanguageSignatureHelp,
  PiariumLanguageSymbol,
  PiariumLanguageTextEdit,
  PiariumLanguageWorkspaceEdit,
  Subscription,
} from '@piarium/ui/lib/api/types';
import type { JsonValue } from '@piarium/extension-contract';
import { LanguageServicesError, parseLanguageServicesFailureReason } from '@piarium/ui/lib/api/language-errors';
import { runtimeFetch } from '@piarium/ui/lib/runtime-fetch';
import {
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointWillChange,
} from '@piarium/ui/lib/runtime-switch';

const assertGeneration = (generation: number): void => {
  if (generation !== getRuntimeEndpointGeneration()) {
    throw new LanguageServicesError('Application host endpoint changed', { reason: 'stale-completion' });
  }
};

const postJson = async (path: string, body: unknown): Promise<unknown> => {
  const generation = getRuntimeEndpointGeneration();
  const response = await runtimeFetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assertGeneration(generation);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      reason?: unknown;
    };
    throw new LanguageServicesError(error.error || 'Language request failed', {
      reason: parseLanguageServicesFailureReason(error.reason),
      status: response.status,
    });
  }
  return response.json();
};

const readSseEvents = async (
  response: Response,
  listener: (event: PiariumLanguageServiceEvent) => void,
  signal: AbortSignal,
): Promise<void> => {
  const reader = response.body?.getReader();
  if (!reader) throw new LanguageServicesError('Language event stream is unavailable', { reason: 'failed' });
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((entry) => entry.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as PiariumLanguageServiceEvent;
      if (event && typeof event === 'object' && 'content' in event) continue;
      listener(event);
    }
  }
};

const feature = <T>(method: string, request: PiariumLanguageFeatureRequest) => (
  postJson('/api/language/feature', { method, request }) as Promise<PiariumLanguageFeatureResult<T>>
);

const command = <T>(method: string, request: PiariumLanguageCommandRequest) => (
  postJson('/api/language/feature', { method, request }) as Promise<PiariumLanguageFeatureResult<T>>
);

export const createWebLanguageServicesAPI = (): LanguageServicesAPI => ({
  getStatus: (workspaceId, languageId) => (
    postJson('/api/language/status', { workspaceId, languageId }) as Promise<PiariumLanguageProviderStatus>
  ),
  subscribe(workspaceId, listener, options): Subscription {
    const generation = getRuntimeEndpointGeneration();
    const controller = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => controller.abort());
    void (async () => {
      try {
        assertGeneration(generation);
        const response = await runtimeFetch('/api/language/events', {
          headers: { Accept: 'text/event-stream' },
          query: { workspaceId },
          signal: controller.signal,
        });
        assertGeneration(generation);
        if (!response.ok) {
          throw new LanguageServicesError('Language event stream failed', {
            reason: 'failed',
            status: response.status,
          });
        }
        await readSseEvents(response, listener, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
      } finally {
        unsubscribe();
      }
    })();
    return {
      close() {
        unsubscribe();
        controller.abort();
      },
    };
  },
  syncDocument: (request: PiariumLanguageDocumentSyncRequest) => (
    postJson('/api/language/sync', request) as Promise<PiariumLanguageDocumentSyncResult>
  ),
  completion: (request) => feature<PiariumLanguageCompletionItem[]>('completion', request),
  completionResolve: (request) => feature<PiariumLanguageCompletionItem>('completionResolve', request),
  hover: (request) => feature<PiariumLanguageHover | null>('hover', request),
  signatureHelp: (request) => feature<PiariumLanguageSignatureHelp | null>('signatureHelp', request),
  definition: (request) => feature<PiariumLanguageLocationLink[]>('definition', request),
  references: (request) => feature<PiariumLanguageLocation[]>('references', request),
  documentSymbols: (request) => feature<PiariumLanguageSymbol[]>('documentSymbols', request),
  workspaceSymbols: (request) => feature<PiariumLanguageSymbol[]>('workspaceSymbols', request),
  rename: (request) => feature<PiariumLanguageWorkspaceEdit | null>('rename', request),
  codeActions: (request) => feature<PiariumLanguageCodeAction[]>('codeActions', request),
  codeActionResolve: (request) => feature<PiariumLanguageCodeAction>('codeActionResolve', request),
  executeCommand: (request) => command<JsonValue | null>('executeCommand', request),
  documentFormatting: (request) => feature<PiariumLanguageTextEdit[]>('documentFormatting', request),
  documentRangeFormatting: (request) => feature<PiariumLanguageTextEdit[]>('documentRangeFormatting', request),
  onTypeFormatting: (request) => feature<PiariumLanguageTextEdit[]>('onTypeFormatting', request),
  semanticTokens: (request) => feature<PiariumLanguageSemanticTokens | null>('semanticTokens', request),
  inlayHints: (request) => feature<PiariumLanguageInlayHint[]>('inlayHints', request),
  inlayHintResolve: (request) => feature<PiariumLanguageInlayHint>('inlayHintResolve', request),
  documentHighlights: (request) => feature<PiariumLanguageDocumentHighlight[]>('documentHighlights', request),
  foldingRanges: (request) => feature<PiariumLanguageFoldingRange[]>('foldingRanges', request),
  selectionRanges: (request) => feature<PiariumLanguageSelectionRange[]>('selectionRanges', request),
  documentLinks: (request) => feature<PiariumLanguageDocumentLink[]>('documentLinks', request),
  documentLinkResolve: (request) => feature<PiariumLanguageDocumentLink>('documentLinkResolve', request),
  documentColors: (request) => feature<PiariumLanguageColorInformation[]>('documentColors', request),
  colorPresentations: (request) => feature<PiariumLanguageColorPresentation[]>('colorPresentations', request),
  restart: (workspaceId, languageId) => (
    postJson('/api/language/restart', { workspaceId, languageId }) as Promise<PiariumLanguageProviderStatus>
  ),
  async disposeWorkspace(workspaceId) {
    const generation = getRuntimeEndpointGeneration();
    await postJson('/api/language/dispose-workspace', { workspaceId });
    assertGeneration(generation);
  },
});
