import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteInteger = (value) => Number.isInteger(value) && value >= 0;

export class LanguageMappingError extends Error {
  constructor(message, reason = 'request-failed') {
    super(message);
    this.name = 'LanguageMappingError';
    this.reason = reason;
  }
}

export const mapPosition = (value) => (
  isRecord(value) && finiteInteger(value.line) && finiteInteger(value.character)
    ? { line: value.line, character: value.character }
    : null
);

export const mapRange = (value) => {
  const start = mapPosition(value?.start);
  const end = mapPosition(value?.end);
  return start && end ? { start, end } : null;
};

const jsonArguments = (value) => (Array.isArray(value) ? value : undefined);

export const mapCommand = (value) => {
  if (!isRecord(value) || typeof value.command !== 'string' || typeof value.title !== 'string') return undefined;
  const args = jsonArguments(value.arguments);
  return {
    title: value.title,
    command: value.command,
    ...(args ? { arguments: args } : {}),
  };
};

export const mapMarkup = (value) => {
  if (typeof value === 'string') return { kind: 'plaintext', value };
  if (!isRecord(value) || typeof value.value !== 'string') return null;
  if (value.kind === 'markdown' || value.kind === 'plaintext') {
    return { kind: value.kind, value: value.value };
  }
  if (typeof value.language === 'string') {
    return {
      kind: 'markdown',
      value: `\`\`\`${value.language.replace(/`/g, '')}\n${value.value}\n\`\`\``,
    };
  }
  return { kind: 'plaintext', value: value.value };
};

export const mapMarkupArray = (value) => {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => (
    typeof item === 'string' ? { kind: 'markdown', value: item } : mapMarkup(item)
  )).filter(Boolean);
};

export const resourceFromUri = (uri, workspaceId, root, pathModule = path) => {
  if (typeof uri !== 'string' || !uri) return null;
  let absolutePath;
  try {
    absolutePath = fileURLToPath(uri);
  } catch {
    return null;
  }
  const relative = pathModule.relative(root, absolutePath);
  if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) return null;
  return { workspaceId, resourceId: relative.split(pathModule.sep).join('/') };
};

export const mapLocation = (value, workspaceId, root, pathModule = path) => {
  const resource = resourceFromUri(value?.uri ?? value?.targetUri, workspaceId, root, pathModule);
  const range = mapRange(value?.range ?? value?.targetRange ?? value?.targetSelectionRange);
  return resource && range ? { resource, range } : null;
};

export const mapLocationLink = (value, workspaceId, root, pathModule = path) => {
  const resource = resourceFromUri(value?.targetUri ?? value?.uri, workspaceId, root, pathModule);
  const targetRange = mapRange(value?.targetRange ?? value?.range ?? value?.targetSelectionRange);
  const targetSelectionRange = mapRange(value?.targetSelectionRange ?? value?.targetRange ?? value?.range);
  const originSelectionRange = mapRange(value?.originSelectionRange);
  if (!resource || !targetRange || !targetSelectionRange) return null;
  return {
    resource,
    targetRange,
    targetSelectionRange,
    ...(originSelectionRange ? { originSelectionRange } : {}),
  };
};

export const mapTextEdit = (value) => {
  const range = mapRange(value?.range);
  if (!range || typeof value?.newText !== 'string') return null;
  return {
    range,
    newText: value.newText,
    ...(typeof value.annotationId === 'string' ? { annotationId: value.annotationId } : {}),
  };
};

const mapInsertReplaceEdit = (value) => {
  const insert = mapRange(value?.insert);
  const replace = mapRange(value?.replace);
  if (!insert || !replace || typeof value?.newText !== 'string') return null;
  return { insert, replace, newText: value.newText };
};

const completionTextEdit = (value) => {
  if (!isRecord(value)) return undefined;
  return mapTextEdit(value) ?? mapInsertReplaceEdit(value) ?? undefined;
};

export const mapCompletionItem = (item, resolveToken) => {
  if (!isRecord(item) || typeof item.label !== 'string' || !item.label) return null;
  const textEdit = completionTextEdit(item.textEdit);
  const additionalTextEdits = Array.isArray(item.additionalTextEdits)
    ? item.additionalTextEdits.map(mapTextEdit).filter(Boolean)
    : undefined;
  const documentation = mapMarkup(item.documentation);
  const command = mapCommand(item.command);
  return {
    label: item.label,
    ...(finiteInteger(item.kind) ? { kind: item.kind } : {}),
    ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
    ...(typeof item.insertText === 'string' ? { insertText: item.insertText } : {}),
    ...(item.insertTextFormat === 2 ? { insertTextFormat: 'snippet' } : item.insertTextFormat === 1 ? { insertTextFormat: 'plain' } : {}),
    ...(documentation ? { documentation } : {}),
    ...(typeof item.sortText === 'string' ? { sortText: item.sortText } : {}),
    ...(typeof item.filterText === 'string' ? { filterText: item.filterText } : {}),
    ...(item.preselect === true ? { preselect: true } : {}),
    ...(item.deprecated === true ? { deprecated: true } : {}),
    ...(Array.isArray(item.commitCharacters) ? { commitCharacters: item.commitCharacters.filter((value) => typeof value === 'string') } : {}),
    ...(Array.isArray(item.tags) ? { tags: item.tags.filter(finiteInteger) } : {}),
    ...(textEdit ? { textEdit } : {}),
    ...(additionalTextEdits?.length ? { additionalTextEdits } : {}),
    ...(command ? { command } : {}),
    ...(resolveToken ? { resolveToken } : {}),
  };
};

export const mapHover = (raw) => {
  if (!raw) return null;
  const contents = mapMarkupArray(raw.contents);
  if (contents.length === 0) return null;
  const range = mapRange(raw.range);
  return {
    contents,
    ...(range ? { range } : {}),
  };
};

const mapSignatureParameter = (value) => {
  if (!isRecord(value)) return null;
  const label = typeof value.label === 'string'
    ? value.label
    : Array.isArray(value.label) && value.label.length === 2 && value.label.every(finiteInteger)
      ? [value.label[0], value.label[1]]
      : null;
  if (!label) return null;
  const documentation = mapMarkup(value.documentation);
  return { label, ...(documentation ? { documentation } : {}) };
};

export const mapSignatureHelp = (raw) => {
  if (!isRecord(raw) || !Array.isArray(raw.signatures)) return null;
  const signatures = raw.signatures.map((signature) => {
    if (!isRecord(signature) || typeof signature.label !== 'string') return null;
    const documentation = mapMarkup(signature.documentation);
    const parameters = Array.isArray(signature.parameters)
      ? signature.parameters.map(mapSignatureParameter).filter(Boolean)
      : [];
    return {
      label: signature.label,
      parameters,
      ...(documentation ? { documentation } : {}),
      ...(finiteInteger(signature.activeParameter) ? { activeParameter: signature.activeParameter } : {}),
    };
  }).filter(Boolean);
  return {
    signatures,
    activeSignature: finiteInteger(raw.activeSignature) ? raw.activeSignature : 0,
    activeParameter: finiteInteger(raw.activeParameter) ? raw.activeParameter : 0,
  };
};

const mapSymbol = (value, context) => {
  if (!isRecord(value) || typeof value.name !== 'string' || !finiteInteger(value.kind)) return null;
  const location = value.location ? mapLocation(value.location, context.workspaceId, context.root, context.pathModule) : null;
  const range = mapRange(value.range ?? value.location?.range) ?? location?.range;
  if (!range) return null;
  const selectionRange = mapRange(value.selectionRange);
  const children = Array.isArray(value.children)
    ? value.children.map((child) => mapSymbol(child, context)).filter(Boolean)
    : undefined;
  return {
    name: value.name,
    kind: value.kind,
    range,
    ...(selectionRange ? { selectionRange } : {}),
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(typeof value.containerName === 'string' ? { containerName: value.containerName } : {}),
    ...(Array.isArray(value.tags) ? { tags: value.tags.filter(finiteInteger) } : {}),
    ...(location ? { resource: location.resource } : {}),
    ...(children?.length ? { children } : {}),
  };
};

export const mapSymbols = (raw, context) => (
  (Array.isArray(raw) ? raw : []).map((value) => mapSymbol(value, context)).filter(Boolean)
);

const mapChangeAnnotations = (value) => {
  if (!isRecord(value)) return undefined;
  const result = {};
  for (const [id, annotation] of Object.entries(value)) {
    if (!isRecord(annotation) || typeof annotation.label !== 'string') continue;
    result[id] = {
      label: annotation.label,
      ...(typeof annotation.description === 'string' ? { description: annotation.description } : {}),
      ...(annotation.needsConfirmation === true ? { needsConfirmation: true } : {}),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

export const mapWorkspaceEdit = (raw, context) => {
  if (!isRecord(raw)) return null;
  const documentChanges = [];
  const requireResource = (uri) => {
    const resource = resourceFromUri(uri, context.workspaceId, context.root, context.pathModule);
    if (!resource) {
      throw new LanguageMappingError('Workspace edit targets an unsupported resource', 'unsupported');
    }
    return resource;
  };
  const requireEdits = (values) => {
    if (!Array.isArray(values)) throw new LanguageMappingError('Workspace edit contains invalid text edits');
    const edits = values.map(mapTextEdit);
    if (edits.some((edit) => !edit)) throw new LanguageMappingError('Workspace edit contains an invalid text edit');
    return edits;
  };
  if (isRecord(raw.changes)) {
    for (const [uri, values] of Object.entries(raw.changes)) {
      const resource = requireResource(uri);
      const edits = requireEdits(values);
      documentChanges.push({ kind: 'text', resource, version: null, edits });
    }
  }
  if (Array.isArray(raw.documentChanges)) {
    for (const change of raw.documentChanges) {
      if (!isRecord(change)) continue;
      if (isRecord(change.textDocument) && typeof change.textDocument.uri === 'string') {
        const resource = requireResource(change.textDocument.uri);
        documentChanges.push({
          kind: 'text',
          resource,
          version: Number.isInteger(change.textDocument.version) ? change.textDocument.version : null,
          edits: requireEdits(change.edits),
        });
        continue;
      }
      if (change.kind === 'create') {
        const resource = requireResource(change.uri);
        const options = isRecord(change.options) ? change.options : {};
        documentChanges.push({
          kind: 'create',
          resource,
          ...(options.overwrite === true ? { overwrite: true } : {}),
          ...(options.ignoreIfExists === true ? { ignoreIfExists: true } : {}),
          ...(typeof change.annotationId === 'string' ? { annotationId: change.annotationId } : {}),
        });
      } else if (change.kind === 'rename') {
        const from = requireResource(change.oldUri);
        const to = requireResource(change.newUri);
        const options = isRecord(change.options) ? change.options : {};
        documentChanges.push({
          kind: 'rename',
          from,
          to,
          ...(options.overwrite === true ? { overwrite: true } : {}),
          ...(options.ignoreIfExists === true ? { ignoreIfExists: true } : {}),
          ...(typeof change.annotationId === 'string' ? { annotationId: change.annotationId } : {}),
        });
      } else if (change.kind === 'delete') {
        const resource = requireResource(change.uri);
        const options = isRecord(change.options) ? change.options : {};
        documentChanges.push({
          kind: 'delete',
          resource,
          ...(options.recursive === true ? { recursive: true } : {}),
          ...(options.ignoreIfNotExists === true ? { ignoreIfNotExists: true } : {}),
          ...(typeof change.annotationId === 'string' ? { annotationId: change.annotationId } : {}),
        });
      }
    }
  }
  const changeAnnotations = mapChangeAnnotations(raw.changeAnnotations);
  return { documentChanges, ...(changeAnnotations ? { changeAnnotations } : {}) };
};

export const mapDiagnostic = (diagnostic, context) => {
  const range = mapRange(diagnostic?.range) ?? {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
  const relatedInformation = Array.isArray(diagnostic?.relatedInformation)
    ? diagnostic.relatedInformation.map((item) => {
        const location = mapLocation(item?.location, context.workspaceId, context.root, context.pathModule);
        return location && typeof item?.message === 'string' ? { location, message: item.message } : null;
      }).filter(Boolean)
    : undefined;
  return {
    resource: context.resource,
    documentVersion: context.documentVersion,
    severity: context.severity(diagnostic?.severity),
    message: typeof diagnostic?.message === 'string' ? diagnostic.message : 'Diagnostic',
    range,
    ...(typeof diagnostic?.code === 'string' || typeof diagnostic?.code === 'number' ? { code: diagnostic.code } : {}),
    ...(typeof diagnostic?.source === 'string' ? { source: diagnostic.source } : {}),
    ...(Array.isArray(diagnostic?.tags) ? { tags: diagnostic.tags.filter(finiteInteger) } : {}),
    ...(relatedInformation?.length ? { relatedInformation } : {}),
    providerId: context.providerId,
    generation: context.generation,
  };
};

export const mapCodeAction = (value, context, resolveToken) => {
  if (!isRecord(value) || typeof value.title !== 'string' || !value.title) return null;
  const edit = mapWorkspaceEdit(value.edit, context);
  const command = mapCommand(isRecord(value.command)
    ? value.command
    : typeof value.command === 'string'
      ? value
      : null);
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics.map((diagnostic) => mapDiagnostic(diagnostic, context.diagnosticContext))
    : undefined;
  return {
    title: value.title,
    ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
    ...(value.isPreferred === true ? { isPreferred: true } : {}),
    ...(typeof value.disabled?.reason === 'string' ? { disabledReason: value.disabled.reason } : {}),
    ...(diagnostics?.length ? { diagnostics } : {}),
    ...(edit ? { edit } : {}),
    ...(command ? { command } : {}),
    ...(resolveToken ? { resolveToken } : {}),
  };
};

export const mapInlayHint = (value, context, resolveToken) => {
  const position = mapPosition(value?.position);
  if (!position) return null;
  let label;
  if (typeof value.label === 'string') label = value.label;
  else if (Array.isArray(value.label)) {
    label = value.label.map((part) => {
      if (!isRecord(part) || typeof part.value !== 'string') return null;
      const tooltip = mapMarkup(part.tooltip);
      const location = mapLocation(part.location, context.workspaceId, context.root, context.pathModule);
      const command = mapCommand(part.command);
      return {
        value: part.value,
        ...(tooltip ? { tooltip } : {}),
        ...(location ? { location } : {}),
        ...(command ? { command } : {}),
      };
    }).filter(Boolean);
  }
  if (typeof label !== 'string' && !Array.isArray(label)) return null;
  const tooltip = mapMarkup(value.tooltip);
  const textEdits = Array.isArray(value.textEdits) ? value.textEdits.map(mapTextEdit).filter(Boolean) : undefined;
  return {
    position,
    label,
    ...(value.kind === 1 ? { kind: 'type' } : value.kind === 2 ? { kind: 'parameter' } : {}),
    ...(tooltip ? { tooltip } : {}),
    ...(textEdits?.length ? { textEdits } : {}),
    ...(value.paddingLeft === true ? { paddingLeft: true } : {}),
    ...(value.paddingRight === true ? { paddingRight: true } : {}),
    ...(resolveToken ? { resolveToken } : {}),
  };
};

export const mapDocumentLink = (value, context, resolveToken) => {
  const range = mapRange(value?.range);
  if (!range) return null;
  let target;
  if (typeof value.target === 'string') {
    const resource = resourceFromUri(value.target, context.workspaceId, context.root, context.pathModule);
    target = resource ? { kind: 'resource', resource } : { kind: 'uri', uri: value.target };
  }
  return {
    range,
    ...(target ? { target } : {}),
    ...(typeof value.tooltip === 'string' ? { tooltip: value.tooltip } : {}),
    ...(resolveToken ? { resolveToken } : {}),
  };
};

export const mapSelectionRange = (value) => {
  const range = mapRange(value?.range);
  if (!range) return null;
  const parent = value.parent ? mapSelectionRange(value.parent) : null;
  return { range, ...(parent ? { parent } : {}) };
};

export const mapDocumentHighlight = (value) => {
  const range = mapRange(value?.range);
  if (!range) return null;
  return {
    range,
    ...(value.kind === 1 ? { kind: 'text' } : value.kind === 2 ? { kind: 'read' } : value.kind === 3 ? { kind: 'write' } : {}),
  };
};

export const mapFoldingRange = (value) => {
  if (!finiteInteger(value?.startLine) || !finiteInteger(value?.endLine)) return null;
  return {
    startLine: value.startLine,
    endLine: value.endLine,
    ...(finiteInteger(value.startCharacter) ? { startCharacter: value.startCharacter } : {}),
    ...(finiteInteger(value.endCharacter) ? { endCharacter: value.endCharacter } : {}),
    ...(value.kind === 'comment' || value.kind === 'imports' || value.kind === 'region' ? { kind: value.kind } : {}),
  };
};

export const mapColorInformation = (value) => {
  const range = mapRange(value?.range);
  const color = value?.color;
  if (!range || !isRecord(color) || ![color.red, color.green, color.blue, color.alpha].every(Number.isFinite)) return null;
  return {
    range,
    color: { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha },
  };
};

export const mapColorPresentation = (value) => {
  if (!isRecord(value) || typeof value.label !== 'string') return null;
  const textEdit = mapTextEdit(value.textEdit);
  const additionalTextEdits = Array.isArray(value.additionalTextEdits)
    ? value.additionalTextEdits.map(mapTextEdit).filter(Boolean)
    : undefined;
  return {
    label: value.label,
    ...(textEdit ? { textEdit } : {}),
    ...(additionalTextEdits?.length ? { additionalTextEdits } : {}),
  };
};

export const mapTextEdits = (raw) => (Array.isArray(raw) ? raw.map(mapTextEdit).filter(Boolean) : []);
