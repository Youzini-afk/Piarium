import type * as vscode from 'vscode';
import {
  parsePiariumExtensionActualState,
  parsePiariumExtensionPackageInstallRequest,
  type PiariumExtensionActualState,
} from '@piarium/extension-contract';
import {
  ApplicationExtensionCatalog,
  ExtensionPackageManager,
} from '@piarium/extension-host';

interface BridgeRequest {
  id: string;
  payload?: unknown;
  type: string;
}

interface BridgeResponse {
  data?: unknown;
  id: string;
  success: boolean;
  type: string;
}

interface ExtensionRuntime {
  catalog: ApplicationExtensionCatalog;
  packages: ExtensionPackageManager;
}

const runtimes = new WeakMap<vscode.ExtensionContext, ExtensionRuntime>();

const getRuntime = (context: vscode.ExtensionContext): ExtensionRuntime => {
  const existing = runtimes.get(context);
  if (existing) return existing;
  const dataDir = context.globalStorageUri.fsPath;
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const runtime = {
    catalog,
    packages: new ExtensionPackageManager({ catalog, dataDir }),
  };
  runtimes.set(context, runtime);
  return runtime;
};

const payloadRecord = (value: unknown): Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

export const handleExtensionsBridgeMessage = async (
  request: BridgeRequest,
  context?: vscode.ExtensionContext,
): Promise<BridgeResponse | null> => {
  if (!request.type.startsWith('api:extensions:')) return null;
  if (!context) throw new Error('VS Code extension context is unavailable');
  const runtime = getRuntime(context);
  switch (request.type) {
    case 'api:extensions:catalog':
      return {
        data: { supported: true, status: 'ready', snapshot: await runtime.catalog.snapshot() },
        id: request.id,
        success: true,
        type: request.type,
      };
    case 'api:extensions:asset':
      return { data: await runtime.packages.readAsset(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:entrypoint':
      return { data: await runtime.packages.readManagedEntrypoint(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:install': {
      const install = parsePiariumExtensionPackageInstallRequest(request.payload);
      return {
        data: await runtime.packages.installOrStage(install.source, install.expectedRevision),
        id: request.id,
        success: true,
        type: request.type,
      };
    }
    case 'api:extensions:candidate:select':
      return { data: await runtime.packages.selectCandidate(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:actual': {
      const payload = payloadRecord(request.payload);
      const extensionId = typeof payload.extensionId === 'string' ? payload.extensionId : '';
      const state: PiariumExtensionActualState = parsePiariumExtensionActualState(payload.state);
      await runtime.packages.reportActualState(extensionId, state);
      return { id: request.id, success: true, type: request.type };
    }
    default:
      return null;
  }
};
