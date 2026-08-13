import { focusChatInput } from '@/components/chat/composer/editor/dom';
import {
  formatCodeSelectionMarkdown,
  rangeToMarkdown,
  trimSelectionValue,
  wrapMarkdownSelectionForChat,
} from '@/components/chat/message/selectionMarkdown';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { piPendingDraftKey, usePiDraftStore } from '@/stores/usePiDraftStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';

const CHAT_INPUT_SELECTOR = '[data-pi-chat-input="true"], [data-chat-input="true"]';

const isInsideChatComposer = (node: Node | null): boolean => {
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element?.closest(CHAT_INPUT_SELECTOR));
};

const captureTextControlSelection = (): string | null => {
  const element = document.activeElement;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return null;
  if (isInsideChatComposer(element)) return null;
  if (element instanceof HTMLInputElement && !['text', 'search', 'url', 'tel'].includes(element.type)) return null;
  const text = trimSelectionValue(element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0));
  return text ? wrapMarkdownSelectionForChat(text) : null;
};

const captureCodeMirrorSelection = async (
  editor: HTMLElement | null,
): Promise<string | null> => {
  if (!editor || isInsideChatComposer(editor)) return null;
  const { EditorView } = await import('@codemirror/view');
  const view = EditorView.findFromDOM(editor);
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const text = trimSelectionValue(view.state.sliceDoc(from, to));
  if (!text) return null;
  view.dispatch({ selection: { anchor: to } });
  return formatCodeSelectionMarkdown(text);
};

const captureDomSelection = (): string | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (isInsideChatComposer(range.commonAncestorContainer)) return null;
  const text = trimSelectionValue(selection.toString());
  if (!text) return null;
  const markdown = rangeToMarkdown(range, text);
  selection.removeAllRanges();
  return wrapMarkdownSelectionForChat(markdown);
};

export const capturePiSelectionMarkdown = async (): Promise<string | null> => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const editor = document.querySelector<HTMLElement>('.cm-editor.cm-focused');
  if (editor && !isInsideChatComposer(editor)) return captureCodeMirrorSelection(editor);
  return captureTextControlSelection() ?? captureDomSelection();
};

export const addPiSelectionToChat = async (): Promise<boolean> => {
  const markdown = await capturePiSelectionMarkdown();
  const sessionId = usePiSessionStore.getState().currentSessionId;
  const directory = useDirectoryStore.getState().currentDirectory;
  const ui = useUIStore.getState();
  ui.setActiveMainTab('chat');
  ui.setSessionSwitcherOpen(false);
  if (markdown) {
    if (sessionId) usePiDraftStore.getState().appendText(sessionId, markdown);
    else if (directory) {
      const state = usePiDraftStore.getState();
      const runtimeKey = usePiSessionStore.getState().runtimeKey;
      const current = state.drafts[piPendingDraftKey(directory, runtimeKey)];
      state.setPendingDraft(directory, {
        text: [current?.text.trimEnd(), markdown].filter(Boolean).join('\n\n'),
      }, runtimeKey);
    }
  }
  queueMicrotask(focusChatInput);
  return markdown !== null;
};
