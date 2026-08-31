import type { editor, IMarkdownString, IPosition, IRange, languages, Uri } from 'monaco-editor/editor';

import type {
  PiariumLanguageColorInformation,
  PiariumLanguageColorPresentation,
  PiariumLanguageCompletionItem,
  PiariumLanguageDiagnostic,
  PiariumLanguageDocumentHighlight,
  PiariumLanguageDocumentLink,
  PiariumLanguageFoldingRange,
  PiariumLanguageHover,
  PiariumLanguageInlayHint,
  PiariumLanguageLocation,
  PiariumLanguageLocationLink,
  PiariumLanguageMarkupContent,
  PiariumLanguageRange,
  PiariumLanguageSelectionRange,
  PiariumLanguageSemanticTokens,
  PiariumLanguageSignatureHelp,
  PiariumLanguageSymbol,
  PiariumLanguageTextEdit,
  PiariumResourceReference,
} from '@piarium/application-client';
import type { MonacoRuntime } from './runtime';

export const PIARIUM_RESOURCE_URI_SCHEME = 'piarium-resource';

export type MonacoResolvableCompletionItem = languages.CompletionItem & {
  __piariumResolveToken?: string;
  __piariumContext?: PiariumResolvableContext;
};

export type MonacoResolvableInlayHint = languages.InlayHint & {
  __piariumResolveToken?: string;
  __piariumContext?: PiariumResolvableContext;
};

export type MonacoResolvableLink = languages.ILink & {
  __piariumResolveToken?: string;
  __piariumContext?: PiariumResolvableContext;
};

export type PiariumResolvableContext = {
  resource: PiariumResourceReference;
  languageId: string;
  documentVersion: number;
  providerId: string;
  generation: number;
};

const SEMANTIC_TOKEN_TYPES = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter',
  'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'label',
  'comment', 'string', 'keyword', 'number', 'regexp', 'operator', 'decorator',
];

const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async',
  'modification', 'documentation', 'defaultLibrary',
];

export const PIARIUM_SEMANTIC_TOKENS_LEGEND: languages.SemanticTokensLegend = {
  tokenTypes: SEMANTIC_TOKEN_TYPES,
  tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
};

const positive = (value: number): number => Math.max(0, Number.isFinite(value) ? value : 0);

export const toMonacoPosition = (position: { line: number; character: number }): IPosition => ({
  lineNumber: positive(position.line) + 1,
  column: positive(position.character) + 1,
});

export const toMonacoRange = (range: PiariumLanguageRange): IRange => ({
  startLineNumber: positive(range.start.line) + 1,
  startColumn: positive(range.start.character) + 1,
  endLineNumber: positive(range.end.line) + 1,
  endColumn: positive(range.end.character) + 1,
});

export const fromMonacoPosition = (position: IPosition) => ({
  line: Math.max(0, position.lineNumber - 1),
  character: Math.max(0, position.column - 1),
});

export const fromMonacoRange = (range: IRange): PiariumLanguageRange => ({
  start: { line: Math.max(0, range.startLineNumber - 1), character: Math.max(0, range.startColumn - 1) },
  end: { line: Math.max(0, range.endLineNumber - 1), character: Math.max(0, range.endColumn - 1) },
});

export const toMonacoResourceUri = (
  monaco: MonacoRuntime,
  resource: PiariumResourceReference,
): Uri => monaco.Uri.from({
  scheme: PIARIUM_RESOURCE_URI_SCHEME,
  authority: resource.workspaceId,
  path: `/${resource.resourceId}`,
});

export const parseMonacoResourceUri = (uri: Uri): PiariumResourceReference | null => {
  if (uri.scheme !== PIARIUM_RESOURCE_URI_SCHEME || !uri.authority) return null;
  const resourceId = uri.path.replace(/^\/+/, '').replace(/\\/g, '/');
  if (!resourceId) return null;
  const segments = resourceId.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return { workspaceId: uri.authority, resourceId };
};

const MARKDOWN_CONTROL_CHARACTERS = ['\\', '`', '*', '_', '{', '}', '[', ']', '<', '>', '(', ')', '#', '+', '-', '.', '!', '|'];

const escapeMarkdown = (value: string): string => MARKDOWN_CONTROL_CHARACTERS.reduce(
  (escaped, character) => escaped.split(character).join(`\\${character}`),
  value,
);

export const toMonacoMarkdown = (content: PiariumLanguageMarkupContent): IMarkdownString => ({
  value: content.kind === 'plaintext' ? escapeMarkdown(content.value) : content.value,
  isTrusted: false,
  supportHtml: false,
});

const completionKind = (monaco: MonacoRuntime, kind?: number): languages.CompletionItemKind => {
  const values = monaco.languages.CompletionItemKind;
  return ({
    1: values.Text,
    2: values.Method,
    3: values.Function,
    4: values.Constructor,
    5: values.Field,
    6: values.Variable,
    7: values.Class,
    8: values.Interface,
    9: values.Module,
    10: values.Property,
    11: values.Unit,
    12: values.Value,
    13: values.Enum,
    14: values.Keyword,
    15: values.Snippet,
    16: values.Color,
    17: values.File,
    18: values.Reference,
    19: values.Folder,
    20: values.EnumMember,
    21: values.Constant,
    22: values.Struct,
    23: values.Event,
    24: values.Operator,
    25: values.TypeParameter,
  } as Record<number, languages.CompletionItemKind>)[kind ?? 0] ?? values.Text;
};

const completionRange = (
  item: PiariumLanguageCompletionItem,
  fallbackRange: IRange,
): { insertText: string; range: IRange | languages.CompletionItemRanges } => {
  const textEdit = item.textEdit;
  if (textEdit && 'range' in textEdit) {
    return { insertText: textEdit.newText, range: toMonacoRange(textEdit.range) };
  }
  if (textEdit && 'insert' in textEdit) {
    return {
      insertText: textEdit.newText,
      range: { insert: toMonacoRange(textEdit.insert), replace: toMonacoRange(textEdit.replace) },
    };
  }
  return { insertText: item.insertText ?? item.label, range: fallbackRange };
};

export const toMonacoCompletionItem = (
  monaco: MonacoRuntime,
  item: PiariumLanguageCompletionItem,
  fallbackRange: IRange,
): MonacoResolvableCompletionItem => {
  const edit = completionRange(item, fallbackRange);
  return {
    label: item.label,
    kind: completionKind(monaco, item.kind),
    insertText: edit.insertText,
    range: edit.range,
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.documentation ? { documentation: toMonacoMarkdown(item.documentation) } : {}),
    ...(item.sortText ? { sortText: item.sortText } : {}),
    ...(item.filterText ? { filterText: item.filterText } : {}),
    ...(item.preselect ? { preselect: true } : {}),
    ...(item.deprecated || item.tags?.includes(1)
      ? { tags: [monaco.languages.CompletionItemTag.Deprecated] }
      : {}),
    ...(item.commitCharacters?.length ? { commitCharacters: item.commitCharacters } : {}),
    ...(item.insertTextFormat === 'snippet'
      ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      : {}),
    ...(item.additionalTextEdits?.length
      ? { additionalTextEdits: item.additionalTextEdits.map(toMonacoTextEdit) }
      : {}),
    ...(item.resolveToken ? { __piariumResolveToken: item.resolveToken } : {}),
  };
};

export const toMonacoHover = (hover: PiariumLanguageHover | null): languages.Hover | null => (
  hover && hover.contents.length > 0
    ? {
        contents: hover.contents.map(toMonacoMarkdown),
        ...(hover.range ? { range: toMonacoRange(hover.range) } : {}),
      }
    : null
);

export const toMonacoSignatureHelp = (
  signature: PiariumLanguageSignatureHelp | null,
): languages.SignatureHelpResult | null => {
  if (!signature) return null;
  return {
    value: {
      activeParameter: signature.activeParameter,
      activeSignature: signature.activeSignature,
      signatures: signature.signatures.map((item) => ({
        label: item.label,
        documentation: item.documentation ? toMonacoMarkdown(item.documentation) : undefined,
        parameters: item.parameters.map((parameter) => ({
          label: parameter.label,
          documentation: parameter.documentation ? toMonacoMarkdown(parameter.documentation) : undefined,
        })),
        activeParameter: item.activeParameter,
      })),
    },
    dispose() {},
  };
};

export const toMonacoLocationLink = (
  monaco: MonacoRuntime,
  location: PiariumLanguageLocationLink,
): languages.LocationLink => ({
  uri: toMonacoResourceUri(monaco, location.resource),
  range: toMonacoRange(location.targetRange),
  targetSelectionRange: toMonacoRange(location.targetSelectionRange),
  ...(location.originSelectionRange ? { originSelectionRange: toMonacoRange(location.originSelectionRange) } : {}),
});

export const toMonacoLocation = (
  monaco: MonacoRuntime,
  location: PiariumLanguageLocation,
): languages.Location => ({
  uri: toMonacoResourceUri(monaco, location.resource),
  range: toMonacoRange(location.range),
});

const symbolKind = (monaco: MonacoRuntime, kind: number): languages.SymbolKind => {
  const values = monaco.languages.SymbolKind;
  return ({
    1: values.File,
    2: values.Module,
    3: values.Namespace,
    4: values.Package,
    5: values.Class,
    6: values.Method,
    7: values.Property,
    8: values.Field,
    9: values.Constructor,
    10: values.Enum,
    11: values.Interface,
    12: values.Function,
    13: values.Variable,
    14: values.Constant,
    15: values.String,
    16: values.Number,
    17: values.Boolean,
    18: values.Array,
    19: values.Object,
    20: values.Key,
    21: values.Null,
    22: values.EnumMember,
    23: values.Struct,
    24: values.Event,
    25: values.Operator,
    26: values.TypeParameter,
  } as Record<number, languages.SymbolKind>)[kind] ?? values.Variable;
};

export const toMonacoDocumentSymbol = (
  monaco: MonacoRuntime,
  symbol: PiariumLanguageSymbol,
): languages.DocumentSymbol => ({
  name: symbol.name,
  detail: symbol.detail ?? '',
  kind: symbolKind(monaco, symbol.kind),
  tags: symbol.tags?.includes(1) ? [monaco.languages.SymbolTag.Deprecated] : [],
  range: toMonacoRange(symbol.range),
  selectionRange: toMonacoRange(symbol.selectionRange ?? symbol.range),
  ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
  ...(symbol.children?.length
    ? { children: symbol.children.map((child) => toMonacoDocumentSymbol(monaco, child)) }
    : {}),
});

export const toMonacoTextEdit = (edit: PiariumLanguageTextEdit): languages.TextEdit => ({
  range: toMonacoRange(edit.range),
  text: edit.newText,
});

const remapSemanticData = (tokens: PiariumLanguageSemanticTokens): Uint32Array => {
  const output: number[] = [];
  for (let index = 0; index + 4 < tokens.data.length; index += 5) {
    const serverType = tokens.legend.tokenTypes[tokens.data[index + 3]];
    const matchedType = SEMANTIC_TOKEN_TYPES.indexOf(serverType);
    const clientType = matchedType >= 0 ? matchedType : SEMANTIC_TOKEN_TYPES.indexOf('variable');
    const serverMask = tokens.data[index + 4] >>> 0;
    let clientMask = 0;
    tokens.legend.tokenModifiers.forEach((modifier, modifierIndex) => {
      if ((serverMask & (1 << modifierIndex)) === 0) return;
      const clientIndex = SEMANTIC_TOKEN_MODIFIERS.indexOf(modifier);
      if (clientIndex >= 0) clientMask |= 1 << clientIndex;
    });
    output.push(
      tokens.data[index],
      tokens.data[index + 1],
      tokens.data[index + 2],
      clientType,
      clientMask >>> 0,
    );
  }
  return new Uint32Array(output);
};

export const toMonacoSemanticTokens = (
  tokens: PiariumLanguageSemanticTokens | null,
): languages.SemanticTokens | null => tokens
  ? { data: remapSemanticData(tokens), ...(tokens.resultId ? { resultId: tokens.resultId } : {}) }
  : null;

export const toMonacoInlayHint = (
  monaco: MonacoRuntime,
  hint: PiariumLanguageInlayHint,
): MonacoResolvableInlayHint => ({
  position: toMonacoPosition(hint.position),
  label: typeof hint.label === 'string'
    ? hint.label
    : hint.label.map((part) => ({
        label: part.value,
        ...(part.tooltip ? { tooltip: toMonacoMarkdown(part.tooltip) } : {}),
        ...(part.location ? { location: toMonacoLocation(monaco, part.location) } : {}),
      })),
  ...(hint.kind === 'type'
    ? { kind: monaco.languages.InlayHintKind.Type }
    : hint.kind === 'parameter'
      ? { kind: monaco.languages.InlayHintKind.Parameter }
      : {}),
  ...(hint.tooltip ? { tooltip: toMonacoMarkdown(hint.tooltip) } : {}),
  ...(hint.textEdits?.length ? { textEdits: hint.textEdits.map(toMonacoTextEdit) } : {}),
  ...(hint.paddingLeft ? { paddingLeft: true } : {}),
  ...(hint.paddingRight ? { paddingRight: true } : {}),
  ...(hint.resolveToken ? { __piariumResolveToken: hint.resolveToken } : {}),
});

export const toMonacoDocumentHighlight = (
  monaco: MonacoRuntime,
  highlight: PiariumLanguageDocumentHighlight,
): languages.DocumentHighlight => ({
  range: toMonacoRange(highlight.range),
  kind: highlight.kind === 'read'
    ? monaco.languages.DocumentHighlightKind.Read
    : highlight.kind === 'write'
      ? monaco.languages.DocumentHighlightKind.Write
      : monaco.languages.DocumentHighlightKind.Text,
});

export const toMonacoFoldingRange = (
  monaco: MonacoRuntime,
  range: PiariumLanguageFoldingRange,
): languages.FoldingRange => ({
  start: range.startLine + 1,
  end: range.endLine + 1,
  ...(range.kind === 'comment'
    ? { kind: monaco.languages.FoldingRangeKind.Comment }
    : range.kind === 'imports'
      ? { kind: monaco.languages.FoldingRangeKind.Imports }
      : range.kind === 'region'
        ? { kind: monaco.languages.FoldingRangeKind.Region }
        : {}),
});

export const toMonacoSelectionRanges = (range: PiariumLanguageSelectionRange): languages.SelectionRange[] => {
  const values: languages.SelectionRange[] = [];
  let current: PiariumLanguageSelectionRange | undefined = range;
  while (current) {
    values.push({ range: toMonacoRange(current.range) });
    current = current.parent;
  }
  return values;
};

const documentLinkUrl = (
  monaco: MonacoRuntime,
  link: PiariumLanguageDocumentLink,
): Uri | string | undefined => {
  if (!link.target) return undefined;
  if (link.target.kind === 'resource') return toMonacoResourceUri(monaco, link.target.resource);
  return link.target.uri;
};

export const toMonacoDocumentLink = (
  monaco: MonacoRuntime,
  link: PiariumLanguageDocumentLink,
): MonacoResolvableLink => ({
  range: toMonacoRange(link.range),
  ...(documentLinkUrl(monaco, link) ? { url: documentLinkUrl(monaco, link) } : {}),
  ...(link.tooltip ? { tooltip: link.tooltip } : {}),
  ...(link.resolveToken ? { __piariumResolveToken: link.resolveToken } : {}),
});

export const toMonacoColorInformation = (
  value: PiariumLanguageColorInformation,
): languages.IColorInformation => ({
  range: toMonacoRange(value.range),
  color: value.color,
});

export const toMonacoColorPresentation = (
  value: PiariumLanguageColorPresentation,
): languages.IColorPresentation => ({
  label: value.label,
  ...(value.textEdit ? { textEdit: toMonacoTextEdit(value.textEdit) } : {}),
  ...(value.additionalTextEdits?.length
    ? { additionalTextEdits: value.additionalTextEdits.map(toMonacoTextEdit) }
    : {}),
});

export const markerOwner = (providerId: string, generation: number): string => (
  `piarium-language:${encodeURIComponent(providerId)}:${generation}`
);

export const toMonacoMarker = (
  monaco: MonacoRuntime,
  diagnostic: PiariumLanguageDiagnostic,
): editor.IMarkerData => {
  const range = toMonacoRange(diagnostic.range);
  const tags: NonNullable<editor.IMarkerData['tags']> = [];
  if (diagnostic.tags?.includes(1)) tags.push(monaco.MarkerTag.Unnecessary);
  if (diagnostic.tags?.includes(2)) tags.push(monaco.MarkerTag.Deprecated);
  return {
    message: diagnostic.message,
    severity: diagnostic.severity === 'error'
      ? monaco.MarkerSeverity.Error
      : diagnostic.severity === 'warning'
        ? monaco.MarkerSeverity.Warning
        : diagnostic.severity === 'hint'
          ? monaco.MarkerSeverity.Hint
          : monaco.MarkerSeverity.Info,
    ...range,
    ...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(tags.length ? { tags } : {}),
    ...(diagnostic.relatedInformation?.length ? {
      relatedInformation: diagnostic.relatedInformation.map((item) => ({
        resource: toMonacoResourceUri(monaco, item.location.resource),
        message: item.message,
        ...toMonacoRange(item.location.range),
      })),
    } : {}),
  };
};
