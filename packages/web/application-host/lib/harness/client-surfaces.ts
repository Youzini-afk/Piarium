/**
 * Client-surface bridge (Stage S / D-309): targeted reads and applies of
 * device-local settings on connected UI surfaces.
 *
 * A surface identifies itself when it opens `/api/piarium/events` with
 * `?surface=<id>&kind=<kind>&session=<live-session>`, after an authenticated
 * bind operation. Host-side writes never guess the client identity — the
 * session binding selects the connection, and applies land only on
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
  authKey: string;
  connectionId: string;
  res: Response;
  surfaceId: string;
  kind: string;
  /** Host-validated selected Pi session. */
  sessionId: string;
}

interface PendingRequest {
  authKey: string;
  connectionIds: Set<string>;
  resolve: (value: { surface: ClientSurfaceInfo; results: ClientSurfaceFieldResult[] }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  surface: ClientSurfaceInfo;
}

export interface SurfaceBridgeDeps {
  writeSseEvent(res: Response, event: { type: string; properties: Record<string, unknown> }): void;
  /** Live session registry check; stale connections are evicted before a request. */
  isSessionLive?(sessionId: string): boolean | Promise<boolean>;
}

export function createClientSurfaceBridge({ writeSseEvent, isSessionLive }: SurfaceBridgeDeps) {
  const connections = new Map<Response, SurfaceConnection>();
  const pending = new Map<string, PendingRequest>();

  const attach = (
    res: Response,
    surfaceId: string,
    kind: string,
    authKey: string,
    sessionId: string,
  ) => {
    connections.set(res, {
      authKey,
      connectionId: randomUUID(),
      res,
      surfaceId,
      kind,
      sessionId,
    });
  };

  // A bind authorizes one subsequent SSE connection for one concrete Surface.
  // Repeating the POST replaces the same permit instead of accumulating stale
  // reconnect credits; separate windows have separate surface ids.
  const boundSessions = new Map<string, Map<string, Set<string>>>();
  const bindSession = (authKey: string, sessionId: string, surfaceId: string): void => {
    const sessions = boundSessions.get(authKey) ?? new Map<string, Set<string>>();
    const surfaces = sessions.get(sessionId) ?? new Set<string>();
    surfaces.add(surfaceId);
    sessions.set(sessionId, surfaces);
    boundSessions.set(authKey, sessions);
  };
  const isSessionBound = (authKey: string, sessionId: string, surfaceId: string): boolean => (
    boundSessions.get(authKey)?.get(sessionId)?.has(surfaceId) === true
  );
  const consumeSessionBinding = (authKey: string, sessionId: string, surfaceId: string): boolean => {
    const sessions = boundSessions.get(authKey);
    const surfaces = sessions?.get(sessionId);
    if (!sessions || !surfaces?.delete(surfaceId)) return false;
    if (surfaces.size === 0) sessions.delete(sessionId);
    if (sessions.size === 0) boundSessions.delete(authKey);
    return true;
  };

  const dropSession = (sessionId: string): void => {
    for (const [authKey, sessions] of boundSessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) boundSessions.delete(authKey);
    }
    for (const [res, connection] of connections) {
      if (connection.sessionId === sessionId) dropConnection(res);
    }
  };

  const detach = (res: Response) => {
    connections.delete(res);
  };

  /** Distinct authenticated surfaces for Host-side capability/status hints. */
  const list = (): ClientSurfaceInfo[] => {
    const seen = new Map<string, ClientSurfaceInfo>();
    for (const conn of connections.values()) {
      const identity = `${conn.authKey}\0${conn.surfaceId}`;
      if (!seen.has(identity)) seen.set(identity, { id: conn.surfaceId, kind: conn.kind });
    }
    return [...seen.values()];
  };

  const listForSession = (sessionId: string): ClientSurfaceInfo[] => {
    const seen = new Map<string, ClientSurfaceInfo>();
    for (const conn of connections.values()) {
      if (conn.sessionId !== sessionId) continue;
      const identity = `${conn.authKey}\0${conn.surfaceId}`;
      if (!seen.has(identity)) seen.set(identity, { id: conn.surfaceId, kind: conn.kind });
    }
    return [...seen.values()];
  };

  const failPending = (connection: SurfaceConnection, error: Error) => {
    for (const [id, request] of pending) {
      if (request.surface.id !== connection.surfaceId || request.authKey !== connection.authKey) continue;
      request.connectionIds.delete(connection.connectionId);
      if (request.connectionIds.size > 0) continue;
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(error);
    }
  };

  const request: ClientSurfaceBridge['request'] = async (op, target) => {
    if (isSessionLive && !(await isSessionLive(target.sessionId))) {
      dropSession(target.sessionId);
      throw new HarnessServiceError(
        'unavailable',
        `session ${target.sessionId} is no longer live on this Host`,
      );
    }
    const targets = [...connections.values()];
    const sessionTargets = targets.filter((conn) => conn.sessionId === target.sessionId);
    const targetSurfaces = new Map<string, ClientSurfaceInfo>();
    for (const conn of sessionTargets) {
      const identity = `${conn.authKey}\0${conn.surfaceId}`;
      if (!targetSurfaces.has(identity)) targetSurfaces.set(identity, { id: conn.surfaceId, kind: conn.kind });
    }
    const surfaces = [...targetSurfaces.values()];
    if (surfaces.length === 0) {
      throw new HarnessServiceError(
        'unavailable',
        `no authenticated surface is bound to session ${target.sessionId}`,
      );
    }
    if (surfaces.length > 1) {
      throw new HarnessServiceError(
        'ambiguous',
        `${surfaces.length} authenticated surfaces are connected (${surfaces.map((s) => `${s.kind}:${s.id.slice(0, 8)}`).join(', ')})`,
      );
    }
    const surface = surfaces[0]!;
    const targetIdentity = sessionTargets.find((conn) => conn.surfaceId === surface.id)!;
    const selectedTargets = targets.filter((conn) => (
      conn.surfaceId === surface.id
      && conn.authKey === targetIdentity.authKey
      && conn.sessionId === targetIdentity.sessionId
    ));
    const requestId = `surface-${randomUUID()}`;
    const results = new Promise<{ surface: ClientSurfaceInfo; results: ClientSurfaceFieldResult[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new HarnessServiceError(
          'unavailable',
          `surface ${surface.id} did not acknowledge within ${SURFACE_REQUEST_TIMEOUT_MS}ms — connection may have dropped`,
        ));
      }, SURFACE_REQUEST_TIMEOUT_MS);
      pending.set(requestId, {
        authKey: targetIdentity.authKey,
        connectionIds: new Set(selectedTargets.map((target) => target.connectionId)),
        resolve,
        reject,
        timer,
        surface,
      });
    });
    try {
      for (const conn of selectedTargets) {
        writeSseEvent(conn.res, {
          type: 'piarium:client-settings-request',
          properties: {
            requestId,
            connectionId: conn.connectionId,
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
  const ack = (
    requestId: string,
    surfaceId: string,
    connectionId: string,
    authKey: string,
    results: ClientSurfaceFieldResult[],
  ) => {
    const request = pending.get(requestId);
    if (!request) return false;
    if (request.surface.id !== surfaceId
      || request.authKey !== authKey
      || !request.connectionIds.has(connectionId)) return false;
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
    const stillConnected = [...connections.values()].some((other) => (
      other.surfaceId === conn.surfaceId && other.authKey === conn.authKey
    ));
    if (!stillConnected) {
      failPending(conn, new HarnessServiceError(
        'unavailable',
        `surface ${conn.surfaceId} disconnected before acknowledging`,
      ));
    } else {
      failPending(conn, new HarnessServiceError(
        'unavailable',
        `surface connection ${conn.connectionId} disconnected before acknowledging`,
      ));
    }
  };

  return {
    attach,
    bindSession,
    consumeSessionBinding,
    isSessionBound,
    dropSession,
    detach,
    dropConnection,
    list,
    listForSession,
    request,
    ack,
    /** Testing/inspection: number of in-flight requests. */
    pendingCount: () => pending.size,
  };
}

export type ClientSurfaceBridgeHandle = ReturnType<typeof createClientSurfaceBridge>;
