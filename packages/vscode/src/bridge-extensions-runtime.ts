import { join } from 'node:path';
import type * as vscode from 'vscode';
import {
  parsePiariumExtensionActualState,
  parsePiariumExtensionHostStateWaitRequest,
  parsePiariumExtensionPackageInstallRequest,
  type PiariumExtensionActualState,
} from '@piarium/extension-contract';
import {
  ApplicationExtensionRuntime,
} from '@piarium/extension-host';
import type { VSCodePiRuntime } from './piRuntime';

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
  runtime: ApplicationExtensionRuntime;
}

const runtimes = new WeakMap<vscode.ExtensionContext, Promise<ExtensionRuntime>>();
const waitControllers = new Map<string, AbortController>();

const getRuntime = (
  context: vscode.ExtensionContext,
  piRuntime?: VSCodePiRuntime,
): Promise<ExtensionRuntime> => {
  const existing = runtimes.get(context);
  if (existing) return existing;
  const creating = (async () => {
    const dataDir = context.globalStorageUri.fsPath;
    const runtime = await ApplicationExtensionRuntime.create({
      brokerScript: join(context.extensionUri.fsPath, 'dist', 'broker-child.mjs'),
      dataDir,
    });
    runtime.capabilities.register('pi-runtime', async (method, value) => {
      if (method !== 'request' || !value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('The pi-runtime capability expects a request object');
      }
      if (!piRuntime) throw new Error('VS Code Pi runtime is unavailable');
      const broker = await piRuntime.start();
      const request = value as Record<string, unknown>;
      const target = payloadRecord(request.target);
      const hostMethod = typeof request.method === 'string' ? request.method : '';
      const params = payloadRecord(request.params);
      let result: unknown;
      if (target.kind === 'catalog') result = await broker.requestCatalog(hostMethod as never, params as never);
      else if (target.kind === 'workspace' && typeof target.cwd === 'string') {
        result = await broker.requestForWorkspace(target.cwd, hostMethod as never, params as never);
      } else if (target.kind === 'session' && typeof target.sessionId === 'string') {
        result = await broker.requestForSession(target.sessionId, hostMethod as never, params as never);
      } else throw new Error('The pi-runtime capability target is invalid');
      return (result ?? null) as never;
    });
    await runtime.start().catch(() => undefined);
    context.subscriptions.push({ dispose: () => { void runtime.stop(); } });
    return { runtime };
  })();
  runtimes.set(context, creating);
  return creating;
};

const payloadRecord = (value: unknown): Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

export const handleExtensionsBridgeMessage = async (
  request: BridgeRequest,
  context?: vscode.ExtensionContext,
  piRuntime?: VSCodePiRuntime,
): Promise<BridgeResponse | null> => {
  if (!request.type.startsWith('api:extensions:')) return null;
  if (!context) throw new Error('VS Code extension context is unavailable');
  const { runtime } = await getRuntime(context, piRuntime);
  switch (request.type) {
    case 'api:extensions:activate': {
      const payload = payloadRecord(request.payload);
      await runtime.activateExtension(String(payload.extensionId ?? ''));
      return { id: request.id, success: true, type: request.type };
    }
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
        data: await runtime.installOrStage(install),
        id: request.id,
        success: true,
        type: request.type,
      };
    }
    case 'api:extensions:candidate:prepare': {
      const payload = payloadRecord(request.payload);
      return {
        data: await runtime.prepareCandidate(String(payload.extensionId ?? ''), String(payload.candidateIntegrity ?? '')),
        id: request.id,
        success: true,
        type: request.type,
      };
    }
    case 'api:extensions:candidate:discard-prepared': {
      const payload = payloadRecord(request.payload);
      await runtime.discardPreparedCandidate(String(payload.extensionId ?? ''), String(payload.candidateIntegrity ?? ''));
      return { id: request.id, success: true, type: request.type };
    }
    case 'api:extensions:candidate:review-capabilities':
      return { data: await runtime.reviewCandidateCapabilities(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:candidate:select':
      return { data: await runtime.selectCandidate(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:set-enabled': {
      const payload = payloadRecord(request.payload);
      const expectedRevision = Number(payload.expectedRevision);
      if (typeof payload.enabled !== 'boolean' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('enabled and expectedRevision are required');
      }
      return {
        data: await runtime.setEnabled(String(payload.extensionId ?? ''), payload.enabled, expectedRevision),
        id: request.id,
        success: true,
        type: request.type,
      };
    }
    case 'api:extensions:host-state':
      return { data: await runtime.state(), id: request.id, success: true, type: request.type };
    case 'api:extensions:host-state:wait': {
      const controller = new AbortController();
      waitControllers.set(request.id, controller);
      try {
        return {
          data: await runtime.waitForState(parsePiariumExtensionHostStateWaitRequest(request.payload), controller.signal),
          id: request.id,
          success: true,
          type: request.type,
        };
      } finally {
        waitControllers.delete(request.id);
      }
    }
    case 'api:extensions:host-state:wait:cancel': {
      const payload = payloadRecord(request.payload);
      if (typeof payload.requestId === 'string') waitControllers.get(payload.requestId)?.abort('VS Code Surface closed its host-state wait');
      return { id: request.id, success: true, type: request.type };
    }
    case 'api:extensions:service:invoke':
      return { data: await runtime.invokeService(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:service:select':
      return { data: await runtime.setServiceSelection(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:service:routing:upsert':
      return { data: await runtime.upsertServiceRoutingRule(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:service:routing:remove':
      return { data: await runtime.removeServiceRoutingRule(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:workbench:layout':
      return { data: await runtime.updateWorkbenchLayout(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:workbench:profile:select':
      return { data: await runtime.selectWorkbenchProfile(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:workbench:profile:upsert':
      return { data: await runtime.upsertWorkbenchProfile(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:workbench:profile:remove':
      return { data: await runtime.removeWorkbenchProfile(request.payload), id: request.id, success: true, type: request.type };
    case 'api:extensions:actual': {
      const payload = payloadRecord(request.payload);
      const extensionId = typeof payload.extensionId === 'string' ? payload.extensionId : '';
      const state: PiariumExtensionActualState = parsePiariumExtensionActualState(payload.state);
      await runtime.reportActualState(extensionId, state);
      return { id: request.id, success: true, type: request.type };
    }
    default:
      return null;
  }
};
