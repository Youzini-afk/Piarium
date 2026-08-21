import {
  PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  PIARIUM_CORE_SERVICE_VERSION,
  PIARIUM_WORKBENCH_LAYOUT_SERVICE_ID,
} from '@piarium/extension-contract';

const OWNER = {
  entrypointId: 'workbench-layout',
  extensionId: PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  generation: 1,
};

const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
};

const text = (value, label) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
};

const addressFor = (input) => {
  const profileId = text(input.profileId, 'profileId');
  const workspaceId = input.workspaceId === undefined || input.workspaceId === null
    ? null
    : text(input.workspaceId, 'workspaceId');
  return {
    extensionId: OWNER.extensionId,
    key: JSON.stringify({ profileId, workspaceId }),
    scope: workspaceId ? 'workspace' : 'profile',
  };
};

export const createWorkbenchLayoutServiceHandler = (storage) => async (method, args) => {
  const input = object(args[0], 'workbench layout request');
  const address = addressFor(input);
  if (method === 'read') return storage.read(address);
  if (method === 'write') {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative integer');
    }
    const document = object(input.document, 'document');
    return storage.update(address, input.expectedRevision, 1, document);
  }
  throw new Error(`Unsupported workbench layout service method: ${method}`);
};

export const registerBuiltinWorkbenchLayoutService = async (extensionRuntime) => {
  const catalog = await extensionRuntime.catalog.snapshot();
  const entry = catalog.extensions.find((candidate) => candidate.manifest.id === OWNER.extensionId);
  if (!entry) throw new Error('Built-in IDE Workbench extension is not installed');
  const owner = { ...OWNER, extensionVersion: entry.manifest.version };
  const handler = createWorkbenchLayoutServiceHandler(extensionRuntime.storage);
  await extensionRuntime.services.replaceOwner(owner, [{
    descriptor: {
      id: PIARIUM_WORKBENCH_LAYOUT_SERVICE_ID,
      multiple: true,
      version: PIARIUM_CORE_SERVICE_VERSION,
    },
    handler,
  }]);
  return async () => {
    await extensionRuntime.services.drainOwner(owner);
    extensionRuntime.services.removeOwner(owner);
  };
};
