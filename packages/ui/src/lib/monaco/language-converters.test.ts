import { describe, expect, test } from 'vitest';

import type { MonacoRuntime } from './runtime';
import {
  markerOwner,
  parseMonacoResourceUri,
  toMonacoCompletionItem,
  toMonacoHover,
  toMonacoResourceUri,
  toMonacoSemanticTokens,
} from './language-converters';

const monaco = {
  Uri: {
    from: (value: Record<string, string>) => ({
      ...value,
      toString: () => `${value.scheme}://${value.authority}${value.path}`,
    }),
  },
  languages: {
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    CompletionItemKind: new Proxy({ Text: 18, Function: 1 }, { get: (target, key) => Reflect.get(target, key) ?? 18 }),
    CompletionItemTag: { Deprecated: 1 },
  },
} as unknown as MonacoRuntime;

describe('Monaco language DTO conversion', () => {
  test('preserves completion replacement ranges, snippets, resolve identity, and untrusted markdown', () => {
    const item = toMonacoCompletionItem(monaco, {
      label: 'document',
      kind: 3,
      insertTextFormat: 'snippet',
      documentation: { kind: 'markdown', value: '[docs](command:unsafe)' },
      textEdit: {
        range: { start: { line: 2, character: 3 }, end: { line: 2, character: 6 } },
        newText: 'document(${1:value})',
      },
      resolveToken: '4:2',
    }, {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    });

    expect(item).toMatchObject({
      label: 'document',
      insertText: 'document(${1:value})',
      insertTextRules: 4,
      range: {
        startLineNumber: 3,
        startColumn: 4,
        endLineNumber: 3,
        endColumn: 7,
      },
      documentation: { value: '[docs](command:unsafe)', isTrusted: false, supportHtml: false },
      __piariumResolveToken: '4:2',
    });
    expect(toMonacoHover({
      contents: [{ kind: 'markdown', value: '<script>unsafe()</script>' }],
    })).toMatchObject({
      contents: [{ value: '<script>unsafe()</script>', isTrusted: false, supportHtml: false }],
    });
    expect(toMonacoHover({
      contents: [{ kind: 'plaintext', value: '**not bold**' }],
    })).toMatchObject({ contents: [{ value: '\\*\\*not bold\\*\\*' }] });
  });

  test('uses an opaque workspace resource URI and remaps semantic legends', () => {
    const uri = toMonacoResourceUri(monaco, {
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      resourceId: 'src/a file.ts',
    });
    expect(parseMonacoResourceUri(uri)).toEqual({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      resourceId: 'src/a file.ts',
    });
    expect(parseMonacoResourceUri({ ...uri, path: '/../escape.ts' } as typeof uri)).toBeNull();

    const semantic = toMonacoSemanticTokens({
      data: [0, 2, 3, 0, 1],
      legend: { tokenTypes: ['variable'], tokenModifiers: ['readonly'] },
    });
    expect([...semantic!.data]).toEqual([0, 2, 3, 8, 4]);
    expect(markerOwner('fixture/provider', 7)).toBe('piarium-language:fixture%2Fprovider:7');
  });
});
