/**
 * Client-surface bridge (Stage S / D-309): targeted reads and applies of
 * device-local settings on connected UI surfaces.
 *
 * A surface identifies itself when it opens `/api/piarium/events` with
 * `?surface=<id>&kind=<kind>`. Host-side writes never guess the client
 * identity — the surface registers its own id/kind, and applies land only on
 * connections that declared that identity. The surface acknowledges over
 * `POST /api/piarium/client-settings/ack`; the request resolves with the
 * surface-reported facts (saved/applied/failed), never an assumed success.
 */

import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { HarnessServiceError } from './service-error.js';
import type {
  ClientSurfaceBridge,
  ClientSurfaceFieldResult,
  ClientSurfaceInfo,
} from './settings-service.js';

/**
 * Bound on a surface round-trip: SSE delivery plus a synchronous local store
 * write is millisecond-scale, so a request that outlives this window means the
 * connection died between send and ack — resolve it as unavailable rather than
 * leaking the pending tool call forever.
 */
const SURFACE_REQUEST_TIMEOUT_MS = 15_000;

interface SurfaceConnection {
  res: Response;
  surfaceId: string;
  kind: string;
}

interface PendingRequest {
  resolve: (value: { surface: ClientSurfaceInfo; results: ClientSurfaceFieldResult[] }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  surface: ClientSurfaceInfo;
}

export interface SurfaceBridgeDeps {
  writeSseEvent(res: Response, event: { type: string; properties: Record<string, unknown> }): void;
}

export function createClientSurfaceBridge({ writeSseEvent }: SurfaceBridgeDeps) {
  const connections = new Map<Response, SurfaceConnection>();
  const pending = new Map<string, PendingRequest>();

  const attach = (res: Response, surfaceId: string, kind: string) => {
    connections.set(res, { res, surfaceId, kind });
  };

  const detach = (res: Response) => {
    connections.delete(res);
  };

  /** Distinct connected surfaces (one entry per surface id). */
  const list = (): ClientSurfaceInfo[] => {
    const seen = new Map<string, ClientSurfaceInfo>();
    for (const conn of connections.values()) {
      if (!seen.has(conn.surfaceId)) seen.set(conn.surfaceId, { id: conn.surfaceId, kind: conn.kind });
    }
    return [...seen.values()];
  };

  const failPending = (surfaceId: string, error: Error) => {
    for (const [id, request] of pending) {
      if (request.surface.id !== surfaceId) continue;
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(error);
    }
  };

  const request: ClientSurfaceBridge['request'] = async (op) => {
    const targets = [...connections.values()].filter((conn) => (
      op.surfaceId ? conn.surfaceId === op.surfaceId : true
    ));
    const surfaces = list();
    if (op.surfaceId) {
      if (targets.length === 0) {
        throw new HarnessServiceError(
          'unavailable',
          `surface "${op.surfaceId}" is not connected to this host`,
        );
      }
    } else if (surfaces.length === 0) {
      throw new HarnessServiceError(
        'unavailable',
        'no client surface is connected to this host',
      );
    } else if (surfaces.length > 1) {
      throw new HarnessServiceError(
        'ambiguous',
        `${surfaces.length} surfaces are connected (${surfaces.map((s) => `${s.kind}:${s.id.slice(0, 8)}`).join(', ')}) — pass surface to choose`,
      );
    }
    const surface = surfaces.length === 1
      ? surfaces[0]!
      : { id: op.surfaceId!, kind: targets[0]?.kind ?? 'unknown' };
    const requestId = `surface-${randomUUID()}`;
    const results = new Promise<{ surface: ClientSurfaceInfo; results: ClientSurfaceFieldResult[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new HarnessServiceError(
          'unavailable',
          `surface ${surface.id} did not acknowledge within ${SURFACE_REQUEST_TIMEOUT_MS}ms — connection may have dropped`,
        ));
      }, SURFACE_REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer, surface });
    });
    try {
      for (const conn of targets) {
        writeSseEvent(conn.res, {
          type: 'piarium:client-settings-request',
          properties: {
            requestId,
            surfaceId: conn.surfaceId,
            op: op.type,
            entries: op.entries,
          },
        });
      }
    } catch (error) {
      const request = pending.get(requestId);
      if (request) {
        clearTimeout(request.timer);
        pending.delete(requestId);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
    return results;
  };

  /** The surface reports the real per-entry outcome. */
  const ack = (requestId: string, results: ClientSurfaceFieldResult[]) => {
    const request = pending.get(requestId);
    if (!request) return false;
    clearTimeout(request.timer);
    pending.delete(requestId);
    request.resolve({ surface: request.surface, results });
    return true;
  };

  /** Connection teardown fails its in-flight requests honestly. */
  const dropConnection = (res: Response) => {
    const conn = connections.get(res);
    detach(res);
    if (!conn) return;
    const stillConnected = [...connections.values()].some((other) => other.surfaceId === conn.surfaceId);
    if (!stillConnected) {
      failPending(conn.surfaceId, new HarnessServiceError(
        'unavailable',
        `surface ${conn.surfaceId} disconnected before acknowledging`,
      ));
    }
  };

  return {
    attach,
    detach,
    dropConnection,
    list,
    request,
    ack,
    /** Testing/inspection: number of in-flight requests. */
    pendingCount: () => pending.size,
  };
}

export type ClientSurfaceBridgeHandle = ReturnType<typeof createClientSurfaceBridge>;
