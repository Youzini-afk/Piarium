import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocumentAuthority } from '@piarium/web/application-host/lib/documents/authority';
import { createVSCodeWorkspaceSearch } from './search-runtime';
import { handleWorkspaceSearchBridgeMessage } from './bridge-search-runtime';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const webRoot = path.join(repository, 'packages/web');

async function fixture(withKernel = true) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'piarium-vscode-native-search-'));
  const workspace = path.join(temporary, 'workspace with spaces');
  const extensionPath = path.join(temporary, 'extension');
  const dataDir = path.join(temporary, 'data');
  await mkdir(workspace);
  await mkdir(extensionPath);
  if (withKernel) await cp(path.join(webRoot, 'kernel'), path.join(extensionPath, 'dist/kernel'), { recursive: true });
  const documents = createDocumentAuthority({ hostId: 'vscode-search-test', dataDir, isAllowedRoot: async () => true, isTrusted: async () => true });
  const { workspaceId } = await documents.resolveWorkspace({ path: workspace });
  const version = (JSON.parse(await readFile(path.join(webRoot, 'package.json'), 'utf8')) as { version: string }).version;
  const search = createVSCodeWorkspaceSearch({ extensionPath, dataDir, hostId: 'vscode-search-test', version, documents });
  return {
    workspace, workspaceId, search,
    async dispose() {
      try { await search.dispose(); } finally {
        await documents.dispose();
        // Removal must succeed after the native process and file handles close.
        await rm(temporary, { recursive: true, force: true });
      }
    },
  };
}

test('companion search bridges to a manifest-verified release kernel and closes its authority', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.workspace, 'source.ts'), 'export const nativeCompanionNeedle = 1;\n');
    const response = await handleWorkspaceSearchBridgeMessage({ id: 'search-1', type: 'api:workspace:search-content', payload: { workspaceId: f.workspaceId, query: 'nativeCompanionNeedle', generation: 7 } }, { search: f.search });
    assert.equal(response?.success, true);
    const result = response?.data as { status: string; generation: number; hits: Array<{ resource: { resourceId: string; workspaceId: string }; revision: string }> };
    assert.equal(result.status, 'ready');
    assert.equal(result.generation, 7);
    assert.equal(result.hits.length, 1);
    assert.deepEqual(result.hits[0].resource, { resourceId: 'source.ts', workspaceId: f.workspaceId });
    assert.ok(result.hits[0].revision);
    const escaped = await f.search.searchContent({ workspaceId: f.workspaceId, query: 'needle', paths: ['../outside.ts'] });
    assert.equal(escaped.status, 'failure');
    await f.search.dispose();
    await assert.rejects(f.search.searchContent({ workspaceId: f.workspaceId, query: 'nativeCompanionNeedle' }), /disposed/);
  } finally { await f.dispose(); }
});

test('a VSIX without its kernel fails explicitly instead of launching Cargo or ripgrep', { timeout: 30000 }, async () => {
  const f = await fixture(false);
  try {
    await assert.rejects(f.search.searchContent({ workspaceId: f.workspaceId, query: 'needle' }), /kernel|manifest|ENOENT/i);
  } finally { await f.dispose(); }
});
