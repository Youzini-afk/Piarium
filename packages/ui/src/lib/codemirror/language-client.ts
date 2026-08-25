import React from 'react';
import { autocompletion } from '@codemirror/autocomplete';
import { linter, type Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { hoverTooltip } from '@codemirror/view';
import type { PiariumLanguageDiagnostic } from '@/lib/api/types';
import { getBoundLanguageServices } from '@/lib/language-services/session';
import {
  getLanguageDiagnosticsForResource,
  subscribeLanguageDiagnostics,
} from '@/lib/language-services/diagnostics-registry';
import { languageIdFromResourceId } from '@/lib/language-services/language-id';
import { useDocumentRecord } from '@/lib/documents/hooks';
import type { DocumentIdentity } from '@/lib/documents/types';

const EMPTY_DIAGNOSTICS: readonly PiariumLanguageDiagnostic[] = [];

const positionToOffset = (text: string, line: number, character: number): number => {
  const lines = text.split('\n');
  let offset = 0;
  for (let index = 0; index < line && index < lines.length; index += 1) {
    offset += lines[index].length + 1;
  }
  return Math.min(text.length, offset + Math.max(0, character));
};

export const useDocumentLanguageExtensions = (identity: DocumentIdentity | undefined): Extension[] => {
  const record = useDocumentRecord(identity);
  const language = getBoundLanguageServices();
  const diagnostics = React.useSyncExternalStore(
    subscribeLanguageDiagnostics,
    () => (identity
      ? getLanguageDiagnosticsForResource(identity.workspaceId, identity.resourceId)
      : EMPTY_DIAGNOSTICS),
    () => EMPTY_DIAGNOSTICS,
  );

  return React.useMemo(() => {
    if (!identity || !language) return [];
    const languageId = languageIdFromResourceId(identity.resourceId);
    if (languageId === 'plaintext') return [];
    const buffer = record?.buffer ?? '';
    const documentVersion = record?.localEditRevision ?? 0;
    const lint = linter(() => diagnostics.map((item): Diagnostic => {
      const from = positionToOffset(buffer, item.range.start.line, item.range.start.character);
      const to = positionToOffset(buffer, item.range.end.line, item.range.end.character);
      return {
        from: Math.min(from, to),
        to: Math.max(from, to, from + 1),
        message: item.message,
        severity: item.severity === 'error' || item.severity === 'warning' ? item.severity : 'info',
      };
    }));
    const completion = autocompletion({
      override: [
        async (context) => {
          const line = context.state.doc.lineAt(context.pos);
          const result = await language.completion({
            resource: identity,
            languageId,
            documentVersion,
            position: {
              line: line.number - 1,
              character: context.pos - line.from,
            },
          });
          if (result.status !== 'ready' || result.documentVersion !== documentVersion) return null;
          const word = context.matchBefore(/[\w$]*/);
          return {
            from: word?.from ?? context.pos,
            options: result.value.map((item) => {
              const option: { label: string; apply: string; detail?: string } = {
                label: item.label,
                apply: item.insertText ?? item.label,
              };
              if (item.detail) option.detail = item.detail;
              return option;
            }),
          };
        },
      ],
    });
    const hover = hoverTooltip(async (view, pos) => {
      const line = view.state.doc.lineAt(pos);
      const result = await language.hover({
        resource: identity,
        languageId,
        documentVersion,
        position: {
          line: line.number - 1,
          character: pos - line.from,
        },
      });
      if (result.status !== 'ready' || result.documentVersion !== documentVersion || !result.value) return null;
      return {
        pos,
        create() {
          const dom = document.createElement('div');
          dom.className = 'cm-tooltip-hover px-2 py-1 typography-ui';
          dom.textContent = result.value;
          return { dom };
        },
      };
    });
    return [lint, completion, hover];
  }, [diagnostics, identity, language, record?.buffer, record?.localEditRevision]);
};
