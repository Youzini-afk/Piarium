import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BridgeContext, BridgeRequest, BridgeResponse } from './bridge';

type ParsedDiffHunk = {
  newStart: number;
  oldLines: string[];
  newLines: string[];
};

const VIRTUAL_DIFF_SCHEME = 'piarium-diff';
const virtualDiffContents = new Map<string, string>();
let virtualDiffCounter = 0;
let virtualDiffProvider: vscode.Disposable | undefined;

const ensureVirtualDiffProvider = (ctx?: BridgeContext): void => {
  if (virtualDiffProvider) return;
  virtualDiffProvider = vscode.workspace.registerTextDocumentContentProvider(VIRTUAL_DIFF_SCHEME, {
    provideTextDocumentContent: (uri) => (
      virtualDiffContents.get(new URLSearchParams(uri.query).get('key') || '') ?? ''
    ),
  });
  ctx?.context?.subscriptions.push(virtualDiffProvider);
};

const createVirtualOriginalUri = (modifiedPath: string, content: string): vscode.Uri => {
  const key = `${Date.now()}-${++virtualDiffCounter}`;
  virtualDiffContents.set(key, content);
  if (virtualDiffContents.size > 100) {
    const oldest = virtualDiffContents.keys().next().value;
    if (oldest) virtualDiffContents.delete(oldest);
  }
  return vscode.Uri.from({
    scheme: VIRTUAL_DIFF_SCHEME,
    path: `/${path.basename(modifiedPath) || 'original'}`,
    query: `key=${encodeURIComponent(key)}`,
  });
};

const parseUnifiedDiffHunks = (patch: string): ParsedDiffHunk[] => {
  const hunks: ParsedDiffHunk[] = [];
  let current: ParsedDiffHunk | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      if (current) hunks.push(current);
      current = { newStart: Number(header[1] || 1), oldLines: [], newLines: [] };
      continue;
    }
    if (!current || line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\ No newline')) continue;
    if (line.startsWith('-')) current.oldLines.push(line.slice(1));
    else if (line.startsWith('+')) current.newLines.push(line.slice(1));
    else if (line.startsWith(' ')) {
      current.oldLines.push(line.slice(1));
      current.newLines.push(line.slice(1));
    }
  }
  if (current) hunks.push(current);
  return hunks;
};

const reconstructOriginalContent = (modifiedContent: string, patch: string): string | null => {
  const hunks = parseUnifiedDiffHunks(patch);
  if (hunks.length === 0) return null;
  const lines = modifiedContent.split('\n');
  for (let index = hunks.length - 1; index >= 0; index -= 1) {
    const hunk = hunks[index];
    if (!hunk) continue;
    lines.splice(Math.max(0, hunk.newStart - 1), hunk.newLines.length, ...hunk.oldLines);
  }
  return lines.join('\n');
};

export const handleNativeVSCodeBridgeMessage = async (
  message: BridgeRequest,
  ctx?: BridgeContext,
): Promise<BridgeResponse | null> => {
  const { id, type, payload } = message;
  switch (type) {
    case 'editor:openFile': {
      const { path: filePath, line, column } = payload as { path?: string; line?: number; column?: number };
      if (!filePath) return { id, type, success: false, error: 'Path is required' };
      const options: vscode.TextDocumentShowOptions = {};
      if (typeof line === 'number') {
        const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column ?? 0));
        options.selection = new vscode.Range(position, position);
      }
      // Let VS Code choose the registered editor. openTextDocument/showTextDocument
      // forces notebooks such as .ipynb into their JSON text representation.
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), options);
      return { id, type, success: true };
    }

    case 'editor:openDiff': {
      const body = payload as { original?: string; modified?: string; label?: string; line?: number; patch?: string };
      if (!body.modified) return { id, type, success: false, error: 'Modified path is required' };
      const modifiedUri = vscode.Uri.file(body.modified);
      const modifiedDocument = await vscode.workspace.openTextDocument(modifiedUri);
      let originalUri = body.original ? vscode.Uri.file(body.original) : modifiedUri;
      if (body.patch?.trim()) {
        const originalContent = reconstructOriginalContent(modifiedDocument.getText(), body.patch);
        if (originalContent !== null) {
          ensureVirtualDiffProvider(ctx);
          originalUri = createVirtualOriginalUri(body.modified, originalContent);
        }
      }
      const leftLabel = body.original ? path.basename(body.original) : `${path.basename(body.modified)} (before)`;
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        modifiedUri,
        body.label || `${leftLabel} → ${path.basename(body.modified)}`,
      );
      if (typeof body.line === 'number' && Number.isFinite(body.line)) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const editor = vscode.window.visibleTextEditors.find(
          (candidate) => candidate.document.uri.toString() === modifiedUri.toString(),
        );
        if (editor) {
          const target = new vscode.Position(Math.max(0, Math.trunc(body.line) - 1), 0);
          editor.selection = new vscode.Selection(target, target);
          editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenter);
        }
      }
      return { id, type, success: true };
    }

    case 'vscode:command': {
      const body = (payload || {}) as { command?: string; args?: unknown[] };
      if (!body.command) return { id, type, success: false, error: 'Command is required' };
      const result = await vscode.commands.executeCommand(body.command, ...(body.args || []));
      return { id, type, success: true, data: { result } };
    }

    case 'vscode:openExternalUrl': {
      const target = typeof (payload as { url?: unknown } | undefined)?.url === 'string'
        ? String((payload as { url: string }).url).trim()
        : '';
      if (!target) return { id, type, success: false, error: 'URL is required' };
      await vscode.env.openExternal(vscode.Uri.parse(target));
      return { id, type, success: true, data: { opened: true } };
    }

    default:
      return null;
  }
};
