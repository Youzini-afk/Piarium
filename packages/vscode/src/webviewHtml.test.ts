import assert from 'node:assert/strict';
import { describe, it, mock } from 'bun:test';

mock.module('vscode', () => ({
  env: { language: 'en' },
  l10n: { t: (value: string) => value },
  window: { activeColorTheme: { kind: 1 } },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join('/'),
    }),
  },
}));

const { getWebviewHtml } = await import('./webviewHtml?csp-test');

const cspDirectives = (html: string): Map<string, string[]> => {
  const content = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
  const directives = new Map<string, string[]>();
  for (const directive of content.split(';')) {
    const [name, ...tokens] = directive.trim().split(/\s+/).filter(Boolean);
    if (name) directives.set(name, tokens);
  }
  return directives;
};

const webview = {
  cspSource: 'https://webview.example',
  asWebviewUri: (uri: { fsPath: string }) => `https://webview.example${uri.fsPath}`,
};

describe('VS Code webview content security policy', () => {
  it('allows blob URLs for workers without allowing blob scripts', () => {
    const html = getWebviewHtml({
      extensionUri: { fsPath: '/extension' } as never,
      initialStatus: 'connecting' as never,
      webview: webview as never,
      workspaceFolder: '/workspace',
    });
    const directives = cspDirectives(html);

    assert.ok(directives.get('worker-src')?.includes('blob:'), 'worker-src must allow blob: workers');
    assert.ok(!directives.get('script-src')?.includes('blob:'), 'script-src must not allow blob:');
    assert.deepEqual(directives.get('default-src'), ["'none'"]);
  });
});
