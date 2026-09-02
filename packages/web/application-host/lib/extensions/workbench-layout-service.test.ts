import { describe, expect, it, vi } from 'vitest';
import {
  PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  PIARIUM_WORKBENCH_LAYOUT_SERVICE_ID,
} from '@piarium/extension-contract';
import {
  createWorkbenchLayoutServiceHandler,
  registerBuiltinWorkbenchLayoutService,
} from './workbench-layout-service.js';
import type { HostServiceProvision } from '@piarium/extension-host';
import type { JsonValue } from '@piarium/extension-contract';

const requireObject = (value: JsonValue): Record<string, JsonValue> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object result');
  return value;
};

describe('built-in workbench layout service', () => {
  it('derives the extension namespace and profile/workspace scope on the Host', async () => {
    const storage: Parameters<typeof createWorkbenchLayoutServiceHandler>[0] = {
      read: vi.fn(async (address) => ({ address, authoritative: true, diagnostics: [], document: { data: {}, revision: 0, schemaVersion: 0, updatedAt: '' }, exists: false, storageState: 'missing' })),
      update: vi.fn(async (address, expectedRevision, schemaVersion, document) => ({ address, expectedRevision, schemaVersion, document })),
    };
    const handler = createWorkbenchLayoutServiceHandler(storage);
    const read = requireObject(await handler('read', [{ profileId: 'piarium.ide', workspaceId: 'workspace-1' }]));
    expect(read.address).toMatchObject({
      extensionId: PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
      scope: 'workspace',
    });
    await handler('write', [{
      profileId: 'piarium.ide',
      workspaceId: 'workspace-1',
      expectedRevision: 3,
      document: { schemaVersion: 1 },
    }]);
    expect(storage.update).toHaveBeenCalledWith(read.address, 3, 1, { schemaVersion: 1 });
  });

  it('registers a multi-provider service and drains it on shutdown', async () => {
    let provision: HostServiceProvision | undefined;
    const services: Parameters<typeof registerBuiltinWorkbenchLayoutService>[0]['services'] = {
      replaceOwner: vi.fn(async (_owner, next) => { provision = next[0]; }),
      drainOwner: vi.fn(async () => undefined),
      removeOwner: vi.fn(),
    };
    const runtime: Parameters<typeof registerBuiltinWorkbenchLayoutService>[0] = {
      catalog: {
        snapshot: vi.fn(async () => ({
          extensions: [{ manifest: { id: PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID, version: '0.1.0' } }],
        })),
      },
      services,
      storage: { read: vi.fn(), update: vi.fn() },
    };
    const dispose = await registerBuiltinWorkbenchLayoutService(runtime);
    if (!provision) throw new Error('Expected service provision');
    expect(provision.descriptor).toEqual({
      id: PIARIUM_WORKBENCH_LAYOUT_SERVICE_ID,
      multiple: true,
      version: 1,
    });
    await dispose();
    expect(services.drainOwner).toHaveBeenCalledTimes(1);
    expect(services.removeOwner).toHaveBeenCalledTimes(1);
  });
});
