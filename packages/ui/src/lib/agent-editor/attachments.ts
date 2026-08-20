import { getRuntimeKey } from '@/lib/runtime-switch';
import type { EditorContextAttachment } from './types';

const listeners = new Set<() => void>();
let attachments: EditorContextAttachment[] = [];

const emit = (): void => {
  for (const listener of listeners) listener();
};

export const subscribeEditorContextAttachments = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const listEditorContextAttachments = (
  runtimeKey: string,
  sessionId: string,
): EditorContextAttachment[] => (
  attachments.filter((item) => item.runtimeKey === runtimeKey && item.sessionId === sessionId)
);

export const addEditorContextAttachment = (
  attachment: EditorContextAttachment,
): EditorContextAttachment | { status: 'wrong-runtime' } => {
  if (attachment.runtimeKey !== getRuntimeKey()) return { status: 'wrong-runtime' };
  const duplicate = attachments.find((item) => (
    item.runtimeKey === attachment.runtimeKey
    && item.sessionId === attachment.sessionId
    && item.kind === attachment.kind
    && item.resourceId === attachment.resourceId
    && item.source === attachment.source
    && item.range?.startLine === attachment.range?.startLine
    && item.range?.endLine === attachment.range?.endLine
    && item.diagnosticMessage === attachment.diagnosticMessage
    && item.patch === attachment.patch
  ));
  if (duplicate) return duplicate;
  attachments = [...attachments, attachment];
  emit();
  return attachment;
};

export const removeEditorContextAttachment = (id: string, runtimeKey: string, sessionId: string): void => {
  const next = attachments.filter((item) => (
    item.id !== id || item.runtimeKey !== runtimeKey || item.sessionId !== sessionId
  ));
  if (next.length === attachments.length) return;
  attachments = next;
  emit();
};

export const consumeEditorContextAttachments = (
  runtimeKey: string,
  sessionId: string,
): EditorContextAttachment[] => {
  const taken = listEditorContextAttachments(runtimeKey, sessionId);
  if (taken.length === 0) return [];
  attachments = attachments.filter((item) => item.runtimeKey !== runtimeKey || item.sessionId !== sessionId);
  emit();
  return taken;
};

export const restoreEditorContextAttachments = (items: readonly EditorContextAttachment[]): void => {
  if (items.length === 0) return;
  const runtimeKey = getRuntimeKey();
  const restored = items.filter((item) => item.runtimeKey === runtimeKey);
  if (restored.length === 0) return;
  const seen = new Set(attachments.map((item) => item.id));
  attachments = [...attachments, ...restored.filter((item) => !seen.has(item.id))];
  emit();
};

export const resetEditorContextAttachments = (): void => {
  if (attachments.length === 0) return;
  attachments = [];
  emit();
};
