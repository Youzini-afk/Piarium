import type {
  PiAssistantContent,
  PiAssistantMessage,
  PiSessionMessageEntry,
} from '@piarium/protocol';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  buildPiariumDiagnosticsReport,
  collectPiariumDiagnostics,
} from '@/lib/piariumDiagnostics';
import { usePiSessionStore, type PiSessionViewState } from '@/stores/usePiSessionStore';

const currentSessionRecord = (): PiSessionViewState | null => {
  const state = usePiSessionStore.getState();
  return state.currentSessionId ? state.records[state.currentSessionId] ?? null : null;
};

const currentMessageEntries = (scope: 'all' | 'branch' = 'branch'): PiSessionMessageEntry[] => {
  const record = currentSessionRecord();
  const entries = scope === 'all' ? record?.allEntries?.entries : record?.branchEntries?.entries;
  return (entries ?? []).filter((entry): entry is PiSessionMessageEntry => entry.type === 'message');
};

const truncate = (value: string, maxLength = 160): string => (
  value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`
);

const summarizeContent = (content: PiAssistantContent) => {
  switch (content.type) {
    case 'text':
      return { length: content.text.length, preview: truncate(content.text), type: content.type };
    case 'thinking':
      return {
        length: content.thinking.length,
        preview: truncate(content.thinking),
        redacted: content.redacted ?? false,
        type: content.type,
      };
    case 'toolCall':
      return { id: content.id, name: content.name, type: content.type };
  }
};

const summarizeAssistant = (entry: PiSessionMessageEntry, message: PiAssistantMessage) => ({
  api: message.api,
  content: message.content.map(summarizeContent),
  entryId: entry.id,
  errorMessage: message.errorMessage ?? null,
  model: message.model,
  provider: message.provider,
  responseModel: message.responseModel ?? null,
  stopReason: message.stopReason,
  timestamp: message.timestamp,
  usage: message.usage,
});

const assistantEntries = (): Array<{ entry: PiSessionMessageEntry; message: PiAssistantMessage }> => (
  currentMessageEntries().flatMap((entry) => (
    entry.message.role === 'assistant'
      ? [{ entry, message: entry.message }]
      : []
  ))
);

const isEmptyAssistantMessage = (message: PiAssistantMessage): boolean => (
  message.content.length === 0
  || message.content.every((content) => {
    if (content.type === 'toolCall') return false;
    if (content.type === 'text') return content.text.trim().length === 0;
    return content.thinking.trim().length === 0;
  })
);

const getLastAssistantMessage = () => {
  const entries = assistantEntries();
  const candidate = entries.at(-1);
  if (!candidate) {
    console.info('[Piarium debug] No assistant message is loaded for the active Pi session.');
    return null;
  }
  const summary = summarizeAssistant(candidate.entry, candidate.message);
  console.info('[Piarium debug] Last assistant message:', summary);
  return summary;
};

const piariumDebug = {
  getCurrentSession() {
    const record = currentSessionRecord();
    console.info('[Piarium debug] Current session:', record);
    return record;
  },

  getLastAssistantMessage,

  getAllMessages(truncateContent = false) {
    const messages = currentMessageEntries().map((entry) => entry.message);
    const result = truncateContent
      ? messages.map((message) => {
          if (message.role !== 'assistant') return message;
          return {
            ...message,
            content: message.content.map(summarizeContent),
          };
        })
      : messages;
    console.info(`[Piarium debug] ${messages.length} messages loaded for the active branch.`, result);
    return result;
  },

  getSessionEntries(scope: 'all' | 'branch' = 'branch') {
    const record = currentSessionRecord();
    const result = scope === 'all' ? record?.allEntries ?? null : record?.branchEntries ?? null;
    console.info(`[Piarium debug] ${scope} entries:`, result);
    return result;
  },

  findEmptyMessages() {
    const result = assistantEntries()
      .filter(({ message }) => isEmptyAssistantMessage(message))
      .map(({ entry, message }) => summarizeAssistant(entry, message));
    console.info(`[Piarium debug] Found ${result.length} empty assistant messages.`, result);
    return result;
  },

  checkLastMessage() {
    const entries = assistantEntries();
    const candidate = entries.at(-1);
    const problematic = candidate ? isEmptyAssistantMessage(candidate.message) : false;
    console.info('[Piarium debug] Last assistant message empty:', problematic);
    return problematic;
  },

  getRuntimeState() {
    const state = usePiSessionStore.getState();
    const record = currentSessionRecord();
    const result = {
      catalogCwd: state.catalogCwd,
      catalogLoaded: state.catalogLoaded,
      currentSessionId: state.currentSessionId,
      lastAgentEvent: record?.lastAgentEvent ?? null,
      liveAssistant: record?.liveAssistant ?? null,
      runtimeKey: state.runtimeKey,
      snapshot: record?.snapshot ?? null,
      toolExecutions: record?.toolExecutions ?? {},
    };
    console.info('[Piarium debug] Runtime state:', result);
    return result;
  },

  async getAppStatus() {
    const result = await collectPiariumDiagnostics();
    console.info('[Piarium debug] App diagnostics:', result);
    return result;
  },

  buildDiagnosticsReport: buildPiariumDiagnosticsReport,

  copyTextToClipboard,

  async copyDiagnosticsReport() {
    const report = await buildPiariumDiagnosticsReport();
    const result = await copyTextToClipboard(report);
    return { ...result, report } as const;
  },

  showRetryHelp() {
    console.info('[Piarium debug] If a Pi response is empty or interrupted:');
    console.info('1. Inspect __piariumDebug.getRuntimeState() and getLastAssistantMessage().');
    console.info('2. Open Piarium diagnostics with Ctrl/Cmd+Shift+O and check provider/resource errors.');
    console.info('3. Retry the turn, or select another configured Pi provider/model.');
  },

  checkCompletionStatus() {
    const entries = assistantEntries();
    const last = entries.at(-1);
    const record = currentSessionRecord();
    const result = last
      ? {
          entryId: last.entry.id,
          errorMessage: last.message.errorMessage ?? null,
          hasLiveAssistant: Boolean(record?.liveAssistant),
          runtimeBusy: record?.snapshot?.busy ?? false,
          runtimeStreaming: record?.snapshot?.isStreaming ?? false,
          stopReason: last.message.stopReason,
        }
      : null;
    console.info('[Piarium debug] Completion status:', result);
    return result;
  },
};

if (typeof window !== 'undefined') {
  window.__piariumDebug = piariumDebug;

  window.addEventListener('error', (event) => {
    try {
      const message = event.message || '';
      const source = event.filename || '';
      if (
        typeof message === 'string'
        && message.includes('this._renderer.value.dimensions')
        && /xterm/i.test(String(source))
      ) {
        event.preventDefault();
      }
    } catch {
      // Best-effort suppression for an xterm renderer teardown race.
    }
  });
}
