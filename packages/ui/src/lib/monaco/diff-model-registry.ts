import type { editor } from 'monaco-editor/editor';

import type { MonacoRuntime } from './runtime';

type SnapshotModelEntry = {
  content: string;
  model: editor.ITextModel;
  owners: Set<string>;
};

export type MonacoDiffSnapshotModelHandle = {
  model: editor.ITextModel;
  release(): void;
};

const entriesByRuntime = new WeakMap<object, Map<string, SnapshotModelEntry>>();

const hashText = (value: string, seed: number): number => {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
};

export const monacoDiffContentRevision = (content: string): string => (
  `${content.length.toString(36)}-${hashText(content, 2_166_136_261).toString(36)}-${hashText(content, 333_967_591).toString(36)}`
);

const runtimeEntries = (monaco: MonacoRuntime): Map<string, SnapshotModelEntry> => {
  const current = entriesByRuntime.get(monaco);
  if (current) return current;
  const created = new Map<string, SnapshotModelEntry>();
  entriesByRuntime.set(monaco, created);
  return created;
};

export const acquireMonacoDiffSnapshotModel = (
  monaco: MonacoRuntime,
  input: {
    content: string;
    languageId: string;
    ownerId: string;
    revision: string;
    side: 'original' | 'modified';
    viewId: string;
  },
): MonacoDiffSnapshotModelHandle => {
  const uri = monaco.Uri.from({
    scheme: 'piarium-diff',
    authority: 'snapshot',
    path: `/${encodeURIComponent(input.viewId)}/${input.side}`,
    query: `revision=${encodeURIComponent(input.revision)}`,
  });
  const key = uri.toString();
  const entries = runtimeEntries(monaco);
  let entry = entries.get(key);
  if (entry && entry.content !== input.content) {
    throw new Error(`Monaco diff revision reused with different content: ${input.revision}`);
  }
  if (!entry) {
    entry = {
      content: input.content,
      model: monaco.editor.createModel(input.content, input.languageId, uri),
      owners: new Set(),
    };
    entries.set(key, entry);
  }
  entry.owners.add(input.ownerId);
  let released = false;
  return {
    model: entry.model,
    release() {
      if (released) return;
      released = true;
      entry?.owners.delete(input.ownerId);
      if (!entry || entry.owners.size > 0) return;
      if (entries.get(key) === entry) entries.delete(key);
      entry.model.dispose();
    },
  };
};
