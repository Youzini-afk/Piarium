/**
 * Agent-facing settings service (D-306 / Stage S).
 *
 * Serves the shared `SETTINGS_CATALOG` through the owning authorities:
 *  - `app`         → the Piarium settings document via the serialized store
 *                    (CAS by content-hash revision, atomic multi-field writes).
 *  - `pi-settings` → Pi `settings.get`/`settings.update` on the workspace
 *                    worker (the same path the settings UI uses).
 *  - `client`      → device-local state: reported honestly, never writable.
 *  - `action`      → domain surfaces (extensions, providers, tunnel, …):
 *                    reads report the real action target, writes refuse with a
 *                    pointer instead of faking a config change.
 */

import { createHash } from 'node:crypto';
import {
  SETTINGS_CATALOG,
  getSettingsCatalogEntry,
  listSettingsCategories,
  querySettingsCatalog,
  type SettingsCatalogEntry,
  type SettingsFieldSpec,
} from '@piarium/application-client';
import type {
  PiSettingsSnapshot,
  SettingsActionParams,
  SettingsActionResult,
  SettingsFieldResult,
  SettingsFieldValue,
  SettingsItemResult,
  SettingsReadParams,
  SettingsReadResult,
  SettingsSearchItem,
  SettingsSearchParams,
  SettingsSearchResult,
  SettingsUpdateItem,
  SettingsUpdateParams,
  SettingsUpdateResult,
} from '@piarium/protocol';
import { mergeHarnessSettings } from '@piarium/protocol';
import { HarnessServiceError } from './service-error.js';
import type { PiariumSettingsDocument } from '@piarium/settings-store';
import type { ActionInvocation, ActionStatus, SettingsActionRegistry } from './settings-actions.js';

export interface SettingsServiceCaller {
  workspaceId: string | null;
  sessionId: string;
}

export interface AppPersistOutcome {
  conflict: boolean;
  revision: string;
  document: PiariumSettingsDocument;
}

export interface SettingsServiceDeps {
  readAppSettings(): Promise<PiariumSettingsDocument>;
  /**
   * Serialized CAS write over the app settings document through the same
   * sanitize/merge/domain-effect pipeline as the UI writer. `changes` and
   * `removals` use top-level document keys; `expectedRevision` is checked
   * inside the store lock so concurrent UI writes are never overwritten.
   */
  persistAppSettings(
    changes: Record<string, unknown>,
    removals: readonly string[],
    expectedRevision: string | undefined,
  ): Promise<AppPersistOutcome>;
  /** Pi runtime settings authority for the caller's workspace. */
  requestPi(cwd: string, method: 'settings.get' | 'settings.update', params: unknown): Promise<PiSettingsSnapshot>;
  resolveWorkspaceRoot(workspaceId: string): Promise<string | null>;
  /** Best-effort dynamic option resolution; null = surface-resolved only. */
  resolveOptions?(
    source: string,
    caller: SettingsServiceCaller,
  ): Promise<{ value: string; label?: string }[] | null>;
  /** Domain-action adapters for `action` entries (Stage S). */
  actions?: SettingsActionRegistry;
  /**
   * Targeted surface bridge for `client` entries. Absent = no live surface
   * channel — client entries report `unavailable` honestly.
   */
  clientSurfaces?: ClientSurfaceBridge;
  /** Fires once per successful write with the affected catalog ids. */
  onChanged?(change: {
    owner: 'app' | 'pi-settings' | 'client';
    ids: string[];
    scope: 'host' | 'global' | 'project' | 'client';
    revision: string;
  }): void;
}

/** A connected UI surface that owns device-local settings. */
export interface ClientSurfaceInfo {
  id: string;
  kind: 'desktop' | 'web' | 'mobile' | string;
}

export interface ClientSurfaceFieldResult {
  id: string;
  status: 'applied' | 'failed' | 'unavailable';
  error?: string;
  /** Current values after apply/read (surface-reported fact). */
  values?: Record<string, unknown>;
}

export interface ClientSurfaceBridge {
  /** Connected surfaces the host can address individually. */
  list(): ClientSurfaceInfo[];
  /**
   * Read or apply client-owned fields on one surface. The bridge resolves the
   * target: explicit `surfaceId`, or the single connected surface. Several
   * candidates without a selector = `ambiguous`; none = `unavailable`.
   */
  request(op: {
    type: 'read' | 'apply';
    entries: { id: string; values?: Record<string, unknown> }[];
    surfaceId?: string;
  }): Promise<{
    surface: ClientSurfaceInfo;
    results: ClientSurfaceFieldResult[];
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deterministic content-hash revision over the app settings document. */
export const settingsDocumentRevision = (document: PiariumSettingsDocument): string =>
  createHash('sha256').update(JSON.stringify(sortDeep(document))).digest('hex').slice(0, 32);

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]),
    );
  }
  return value;
};

const getPath = (document: Record<string, unknown>, path: string): unknown => {
  const segments = path.split('.');
  let cursor: unknown = document;
  for (const segment of segments) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
};

const setPath = (document: Record<string, unknown>, path: string, value: unknown): void => {
  const segments = path.split('.');
  let cursor = document;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!isRecord(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) return;
  if (value === undefined) delete cursor[leaf];
  else cursor[leaf] = value;
};

const deletePath = (document: Record<string, unknown>, path: string): void => {
  setPath(document, path, undefined);
};

const entryFields = (entry: SettingsCatalogEntry): readonly SettingsFieldSpec[] =>
  entry.fields ?? (entry.field ? [entry.field] : []);

const toSearchItem = (entry: SettingsCatalogEntry): SettingsSearchItem => ({
  id: entry.id,
  category: entry.category,
  owner: entry.owner,
  titleKey: entry.ui.titleKey,
  paths: entryFields(entry).map((field) => field.path),
  writable: entry.owner === 'app' || entry.owner === 'pi-settings',
  ...(entry.apply ? { apply: entry.apply } : {}),
  page: entry.ui.page,
  ...(entry.ui.keywords ? { keywords: [...entry.ui.keywords] } : {}),
  ...(entry.actionRef?.note ? { note: entry.actionRef.note } : {}),
});

const validateFieldValue = (field: SettingsFieldSpec, value: unknown): string | null => {
  if (value === null || value === undefined) {
    return field.nullable ? null : 'value is not nullable; use reset to clear';
  }
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expected a boolean';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'expected a number';
      if (field.integer && !Number.isInteger(value)) return 'expected an integer';
      if (field.min !== undefined && value < field.min) return `must be >= ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be <= ${field.max}`;
      return null;
    }
    case 'enum': {
      if (typeof value !== 'string') return 'expected a string';
      return field.options?.some((option) => option.value === value)
        ? null
        : `expected one of: ${(field.options ?? []).map((option) => option.value).join(', ')}`;
    }
    case 'string':
      if (typeof value !== 'string') return 'expected a string';
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `must be at most ${field.maxLength} characters`;
      }
      return null;
    case 'string-list':
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? null
        : 'expected an array of strings';
    case 'json':
      return value === undefined ? 'expected a JSON value' : null;
    case 'secret':
      return 'credential fields are status-only and cannot be written through this service';
    default:
      return null;
  }
};

export interface SettingsService {
  search(caller: SettingsServiceCaller, params: SettingsSearchParams): Promise<SettingsSearchResult>;
  read(caller: SettingsServiceCaller, params: SettingsReadParams): Promise<SettingsReadResult>;
  update(caller: SettingsServiceCaller, params: SettingsUpdateParams): Promise<SettingsUpdateResult>;
  /** Invoke a domain action on an `action` entry (D-309). */
  action(caller: SettingsServiceCaller, params: SettingsActionParams): Promise<SettingsActionResult>;
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const search = async (
    caller: SettingsServiceCaller,
    params: SettingsSearchParams,
  ): Promise<SettingsSearchResult> => {
    const matches = querySettingsCatalog({
      ...(params.query !== undefined ? { query: params.query } : {}),
      ...(params.category !== undefined ? { category: params.category as never } : {}),
      ...(params.owner !== undefined ? { owner: params.owner } : {}),
      ...(params.id !== undefined ? { id: params.id } : {}),
    });
    const offset = Math.max(0, params.offset ?? 0);
    const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
    const categories = new Map<string, number>();
    for (const entry of matches) {
      categories.set(entry.category, (categories.get(entry.category) ?? 0) + 1);
    }
    const page = matches.slice(offset, offset + limit);
    const summaries = await summarizeSearchItems(caller, page);
    return {
      items: page.map((entry, index) => {
        const item = toSearchItem(entry);
        const summary = summaries[index];
        return summary ? { ...item, summary } : item;
      }),
      total: matches.length,
      categories: [...categories.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    };
  };

  /**
   * Progressive disclosure for search (S-B): simple entries carry the live
   * facts needed to decide a write — effective value/source for single-field
   * app+pi rows, declared verbs for action rows, connected-surface count for
   * client rows. Owner documents are fetched once per search, never per item.
   */
  const summarizeSearchItems = async (
    caller: SettingsServiceCaller,
    entries: readonly SettingsCatalogEntry[],
  ): Promise<(SettingsSearchItem['summary'] | undefined)[]> => {
    let appDocument: PiariumSettingsDocument | null = null;
    let piSnapshot: PiSettingsSnapshot | null = null;
    const needApp = entries.some((entry) => entry.owner === 'app');
    const needPi = entries.some((entry) => entry.owner === 'pi-settings');
    if (needApp) appDocument = await deps.readAppSettings().catch(() => null);
    if (needPi && caller.workspaceId) {
      const root = await deps.resolveWorkspaceRoot(caller.workspaceId).catch(() => null);
      if (root) piSnapshot = await deps.requestPi(root, 'settings.get', {}).catch(() => null);
    }
    const surfaceCount = deps.clientSurfaces?.list().length ?? 0;
    return entries.map((entry) => {
      const fields = entryFields(entry);
      const single = fields.length === 1 ? fields[0]! : null;
      if (entry.owner === 'action') {
        return { verbs: [...(entry.actionRef?.verbs ?? [])] };
      }
      if (entry.owner === 'client') {
        return { surfaces: surfaceCount };
      }
      if (!single) return undefined;
      const summary: NonNullable<SettingsSearchItem['summary']> = {
        fieldKind: single.kind,
        ...(single.options ? { options: single.options.map((o) => ({ value: o.value, ...(o.labelKey ? { label: o.labelKey } : {}) })) } : {}),
      };
      if (entry.owner === 'app' && appDocument) {
        const saved = getPath(appDocument, single.path);
        if (single.kind === 'secret') {
          summary.isSet = saved !== undefined && saved !== null && saved !== '';
        } else {
          summary.value = saved !== undefined ? saved : single.default;
          summary.source = saved !== undefined ? 'user' : single.default !== undefined ? 'default' : 'none';
        }
        return summary;
      }
      if (entry.owner === 'pi-settings' && piSnapshot) {
        const projectValue = piSnapshot.projectTrusted ? getPath(piSnapshot.project, single.path) : undefined;
        const globalValue = getPath(piSnapshot.global, single.path);
        const effective = projectValue ?? globalValue ?? single.default;
        if (single.kind === 'secret') {
          summary.isSet = effective !== undefined && effective !== null && effective !== '';
        } else {
          summary.value = effective;
          summary.source = projectValue !== undefined ? 'project'
            : globalValue !== undefined ? 'user'
            : single.default !== undefined ? 'default' : 'none';
        }
        return summary;
      }
      // Owner unreachable — kind/options still help the caller shape a read.
      return summary;
    });
  };

  const requireEntry = (id: string): SettingsCatalogEntry => {
    const entry = getSettingsCatalogEntry(id);
    if (!entry) {
      throw new HarnessServiceError('not-found', `unknown settings id "${id}" — search first for stable ids`);
    }
    return entry;
  };

  const resolveOptions = async (
    caller: SettingsServiceCaller,
    fields: readonly SettingsFieldSpec[],
  ): Promise<{ value: string; label?: string }[] | undefined> => {
    const sources = new Set(
      fields.flatMap((field) => (field.optionsSource ? [field.optionsSource] : [])),
    );
    if (sources.size === 0 || !deps.resolveOptions) return undefined;
    const options: { value: string; label?: string }[] = [];
    for (const source of sources) {
      const resolved = await deps.resolveOptions(source, caller).catch(() => null);
      if (resolved) options.push(...resolved);
    }
    return options.length > 0 ? options : undefined;
  };

  const readApp = async (
    entry: SettingsCatalogEntry,
    detail: boolean,
    caller: SettingsServiceCaller,
  ): Promise<SettingsReadResult> => {
    const document = await deps.readAppSettings();
    const fields = entryFields(entry);
    const values: SettingsFieldValue[] = fields.map((field) => {
      const saved = getPath(document, field.path);
      if (field.kind === 'secret') {
        return { path: field.path, kind: field.kind, isSet: saved !== undefined && saved !== null && saved !== '' };
      }
      return { path: field.path, kind: field.kind, saved, isSet: saved !== undefined };
    });
    const effectiveFields = fields.filter((field) => field.kind !== 'secret');
    const effective = effectiveFields.length === 1
      ? (() => {
          const field = effectiveFields[0]!;
          const saved = getPath(document, field.path);
          return {
            value: saved !== undefined ? saved : field.default,
            source: (saved !== undefined ? 'user' : field.default !== undefined ? 'default' : 'none') as 'user' | 'default' | 'none',
          };
        })()
      : undefined;
    return {
      state: 'ok',
      entry: toSearchItem(entry),
      fields: values,
      ...(effective ? { effective } : {}),
      revision: settingsDocumentRevision(document),
      ...(detail ? { related: relatedIds(entry) } : {}),
      ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      ...(await optionBlock(caller, fields, detail)),
    };
  };

  const relatedIds = (entry: SettingsCatalogEntry): string[] =>
    SETTINGS_CATALOG
      .filter((candidate) => candidate.id !== entry.id && candidate.ui.page === entry.ui.page)
      .map((candidate) => candidate.id)
      .slice(0, 12);

  const optionBlock = async (
    caller: SettingsServiceCaller,
    fields: readonly SettingsFieldSpec[],
    detail: boolean,
  ): Promise<Pick<SettingsReadResult, 'options'>> => {
    if (!detail) return {};
    const options = await resolveOptions(caller, fields);
    return options ? { options } : {};
  };

  const readPi = async (
    entry: SettingsCatalogEntry,
    scope: 'global' | 'project' | 'effective',
    detail: boolean,
    caller: SettingsServiceCaller,
  ): Promise<SettingsReadResult> => {
    if (!caller.workspaceId) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: 'pi-settings require a workspace-bound session',
      };
    }
    const root = await deps.resolveWorkspaceRoot(caller.workspaceId);
    if (!root) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: `cannot resolve workspace root for ${caller.workspaceId}`,
      };
    }
    let snapshot: PiSettingsSnapshot;
    try {
      snapshot = await deps.requestPi(root, 'settings.get', {});
    } catch (error) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const fields = entryFields(entry);
    const trustedProject = snapshot.projectTrusted ? snapshot.project : {};
    const pickScope = (path: string, layer: 'global' | 'project') =>
      getPath(layer === 'global' ? snapshot.global : trustedProject, path);
    const values: SettingsFieldValue[] = fields.map((field) => {
      const layer = scope === 'effective' ? undefined : scope;
      const saved = layer ? pickScope(field.path, layer) : undefined;
      return layer
        ? { path: field.path, kind: field.kind, saved, isSet: saved !== undefined }
        : {
            path: field.path,
            kind: field.kind,
            saved: pickScope(field.path, 'global'),
            isSet: pickScope(field.path, 'global') !== undefined || pickScope(field.path, 'project') !== undefined,
          };
    });
    // Effective value: project override beats global; harness.* resolves
    // through the owner's merge so retired keys and user-only fields behave
    // exactly like the running product.
    const merged = mergeHarnessSettings(
      isRecord(snapshot.global.harness) ? snapshot.global.harness as never : {},
      isRecord(trustedProject.harness) ? trustedProject.harness as never : {},
    ) as unknown as Record<string, unknown>;
    const effectiveOf = (path: string): { value: unknown; source: 'user' | 'project' | 'default' | 'none' } => {
      const project = pickScope(path, 'project');
      if (project !== undefined) return { value: project, source: 'project' };
      const global = pickScope(path, 'global');
      if (global !== undefined) return { value: global, source: 'user' };
      if (path.startsWith('harness.')) {
        const mergedValue = getPath(merged, path.slice('harness.'.length));
        if (mergedValue !== undefined) return { value: mergedValue, source: 'default' };
      }
      return { value: undefined, source: 'none' };
    };
    const fields0 = fields[0];
    const effective = fields.length === 1 && fields0
      ? effectiveOf(fields0.path)
      : undefined;
    const deniedProject = scope === 'project' && !snapshot.projectTrusted;
    return {
      state: deniedProject ? 'denied' : 'ok',
      entry: toSearchItem(entry),
      fields: values,
      ...(effective ? { effective } : {}),
      revisions: {
        global: snapshot.globalRevision,
        ...(snapshot.projectTrusted ? { project: snapshot.projectRevision } : {}),
      },
      ...(deniedProject ? { reason: 'project settings file is not trusted' } : {}),
      ...(detail ? { related: relatedIds(entry) } : {}),
      ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      ...(await optionBlock(caller, fields, detail)),
    };
  };

  const read = async (
    caller: SettingsServiceCaller,
    params: SettingsReadParams,
  ): Promise<SettingsReadResult> => {
    const entry = requireEntry(params.id);
    const detail = params.detail === true;
    switch (entry.owner) {
      case 'app':
        if (params.scope === 'global' || params.scope === 'project') {
          throw new HarnessServiceError(
            'denied',
            `"${entry.id}" is host-owned; global/project scope is only valid for pi-settings entries`,
          );
        }
        return readApp(entry, detail, caller);
      case 'pi-settings':
        return readPi(entry, params.scope ?? 'effective', detail, caller);
      case 'client':
        return readClient(entry, caller, params);
      case 'action':
      default:
        return readAction(entry, caller, detail);
    }
  };

  /**
   * `client` entries live on the connected surface. A read asks the surface
   * for its own current values — when no single surface is addressable the
   * result stays honestly `unavailable`/`denied` instead of guessing.
   */
  const readClient = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsReadParams,
  ): Promise<SettingsReadResult> => {
    const bridge = deps.clientSurfaces;
    if (!bridge) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: 'device-local preference owned by the connected surface — no surface channel is registered on this host',
      };
    }
    let response;
    try {
      response = await bridge.request({
        type: 'read',
        entries: [{ id: entry.id }],
        ...(params.surface ? { surfaceId: params.surface } : {}),
      });
    } catch (error) {
      const code = error instanceof HarnessServiceError ? error.harnessCode : undefined;
      return {
        state: code === 'ambiguous' ? 'denied' : 'unavailable',
        entry: toSearchItem(entry),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const result = response.results.find((item) => item.id === entry.id);
    if (!result || result.status === 'unavailable') {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: result?.error ?? `surface ${response.surface.id} does not own ${entry.id}`,
      };
    }
    if (result.status === 'failed') {
      return {
        state: 'malformed',
        entry: toSearchItem(entry),
        reason: result.error ?? 'surface failed to read the value',
      };
    }
    const values = result.values ?? {};
    const paths = Object.keys(values);
    return {
      state: 'ok',
      entry: toSearchItem(entry),
      fields: paths.map((path) => ({ path, kind: 'json', saved: values[path], isSet: values[path] !== undefined })),
      ...(paths.length === 1
        ? { effective: { value: values[paths[0]!], source: 'user' as const } }
        : {}),
      revision: `surface:${response.surface.id}`,
    };
  };

  /**
   * `action` entries describe a live domain surface. The adapter reports the
   * owner's real state and the verbs it can execute right now; without an
   * adapter the entry keeps its static pointer (still honest — not claimed).
   */
  const readAction = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    detail: boolean,
  ): Promise<SettingsReadResult> => {
    const adapter = deps.actions?.adapterFor(entry.actionRef?.domain) ?? null;
    const staticBlock = entry.actionRef
      ? {
          domain: entry.actionRef.domain,
          ...(entry.actionRef.verbs ? { verbs: [...entry.actionRef.verbs] } : {}),
          ...(entry.actionRef.note ? { note: entry.actionRef.note } : {}),
        }
      : undefined;
    if (!adapter) {
      return {
        state: 'action',
        entry: toSearchItem(entry),
        ...(staticBlock ? { action: staticBlock } : {}),
        reason: 'no owner adapter is wired for this domain on this host',
        ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      };
    }
    const status: ActionStatus = await adapter.describe(
      { caller, workspaceRoot: caller.workspaceId ? await deps.resolveWorkspaceRoot(caller.workspaceId).catch(() => null) : null },
      entry,
    ).catch((error: unknown): ActionStatus => ({
      unavailable: error instanceof Error ? error.message : String(error),
    }));
    if (status.unavailable) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        ...(staticBlock ? { action: { ...staticBlock, status: status.unavailable } } : {}),
        reason: status.unavailable,
        ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      };
    }
    return {
      state: 'action',
      entry: toSearchItem(entry),
      action: {
        domain: entry.actionRef?.domain ?? 'unknown',
        verbs: status.verbs ?? (entry.actionRef?.verbs ? [...entry.actionRef.verbs] : []),
        ...(entry.actionRef?.note ? { note: entry.actionRef.note } : {}),
        ...(status.summary ? { status: status.summary } : {}),
        ...(detail && status.data !== undefined ? { data: status.data } : {}),
      },
      ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
    };
  };

  const invokeAction = async (
    caller: SettingsServiceCaller,
    params: SettingsActionParams,
  ): Promise<SettingsActionResult> => {
    const entry = requireEntry(params.id);
    if (entry.owner !== 'action' || !entry.actionRef) {
      throw new HarnessServiceError('denied', `"${entry.id}" is not a domain action entry (owner=${entry.owner})`);
    }
    const adapter = deps.actions?.adapterFor(entry.actionRef.domain) ?? null;
    if (!adapter) {
      return {
        status: 'unavailable',
        entry: toSearchItem(entry),
        verb: params.verb,
        detail: `no owner adapter is wired for ${entry.actionRef.domain}`,
      };
    }
    const declared = entry.actionRef.verbs ?? [];
    if (declared.length > 0 && !declared.includes(params.verb) && params.verb !== 'status') {
      return {
        status: 'denied',
        entry: toSearchItem(entry),
        verb: params.verb,
        detail: `verb "${params.verb}" is not declared on ${entry.id} — declared: ${declared.join(', ') || '(none)'}`,
      };
    }
    const workspaceRoot = caller.workspaceId
      ? await deps.resolveWorkspaceRoot(caller.workspaceId).catch(() => null)
      : null;
    const outcome: ActionInvocation = await adapter.invoke(
      { caller, workspaceRoot },
      entry,
      params.verb,
      params.args ?? {},
    ).catch((error: unknown): ActionInvocation => ({
      status: 'failed' as const,
      detail: error instanceof Error ? error.message : String(error),
    }));
    return {
      status: outcome.status,
      entry: toSearchItem(entry),
      verb: params.verb,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      ...(outcome.operation ? { operation: outcome.operation } : {}),
    };
  };

  /** One validated write spec — a single catalog entry plus its fields. */
  interface AppWrite {
    entry: SettingsCatalogEntry;
    set: Record<string, unknown>;
    reset: string[];
  }

  /**
   * Commit one or more app-owner write specs in a single CAS transaction.
   * Per-item field validation decides membership; once at least one valid
   * field exists the merged change lands atomically — an item with zero valid
   * fields fails on its own without blocking the others.
   */
  const updateAppBatch = async (
    caller: SettingsServiceCaller,
    writes: AppWrite[],
    expectedRevision?: string,
  ): Promise<{
    items: SettingsItemResult[];
    revision?: string;
    effective?: Record<string, unknown>;
    document?: PiariumSettingsDocument;
  }> => {
    const itemResults: SettingsItemResult[] = [];
    const validSets: [string, unknown][] = [];
    const validResets: string[] = [];
    const validEntryIds: string[] = [];
    const allFields: SettingsFieldSpec[] = [];
    for (const write of writes) {
      const byPath = new Map(entryFields(write.entry).map((field) => [field.path, field]));
      const fieldResults: SettingsFieldResult[] = [];
      const itemSets: [string, unknown][] = [];
      const itemResets: string[] = [];
      for (const [path, value] of Object.entries(write.set)) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential fields cannot be written through this service' });
          continue;
        }
        const problem = validateFieldValue(field, value);
        if (problem) {
          fieldResults.push({ path, status: 'failed', error: problem });
          continue;
        }
        itemSets.push([path, value]);
      }
      for (const path of write.reset) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential fields cannot be reset through this service' });
          continue;
        }
        itemResets.push(path);
      }
      if (itemSets.length === 0 && itemResets.length === 0) {
        itemResults.push({
          id: write.entry.id,
          status: 'failed',
          fields: fieldResults,
          error: 'no valid fields to write',
        });
        continue;
      }
      validSets.push(...itemSets);
      validResets.push(...itemResets);
      validEntryIds.push(write.entry.id);
      allFields.push(...entryFields(write.entry));
      itemResults.push({
        id: write.entry.id,
        status: 'applied',
        fields: [
          ...itemSets.map(([path]): SettingsFieldResult => ({ path, status: 'applied' })),
          ...itemResets.map((path): SettingsFieldResult => ({ path, status: 'applied' })),
          ...fieldResults,
        ],
      });
    }
    if (validSets.length === 0 && validResets.length === 0) {
      return { items: itemResults };
    }
    // Nested paths collapse into their top-level key — the persist pipeline
    // merges whole top-level objects, so a partial nested write must
    // read-modify-write its root inside the CAS revision.
    const current = await deps.readAppSettings();
    const changes: Record<string, unknown> = {};
    const removals: string[] = [];
    const nestedRoots = new Map<string, Record<string, unknown>>();
    for (const [path, value] of validSets) {
      if (!path.includes('.')) {
        changes[path] = value;
        continue;
      }
      const rootKey = path.split('.')[0]!;
      const rootObject = nestedRoots.get(rootKey)
        ?? (isRecord(getPath(current, rootKey)) ? structuredClone(getPath(current, rootKey) as Record<string, unknown>) : {});
      nestedRoots.set(rootKey, rootObject);
      setPath(rootObject, path.slice(rootKey.length + 1), value);
    }
    for (const path of validResets) {
      if (!path.includes('.')) {
        removals.push(path);
        continue;
      }
      const rootKey = path.split('.')[0]!;
      const rootObject = nestedRoots.get(rootKey)
        ?? (isRecord(getPath(current, rootKey)) ? structuredClone(getPath(current, rootKey) as Record<string, unknown>) : {});
      nestedRoots.set(rootKey, rootObject);
      deletePath(rootObject, path.slice(rootKey.length + 1));
    }
    for (const [rootKey, rootObject] of nestedRoots) {
      changes[rootKey] = rootObject;
    }
    // Always CAS on the document we just merged against: without an explicit
    // expectedRevision a concurrent UI write between read and transact would
    // otherwise be silently clobbered.
    const outcome = await deps.persistAppSettings(
      changes,
      removals,
      expectedRevision ?? settingsDocumentRevision(current),
    );
    if (outcome.conflict) {
      for (const item of itemResults) {
        if (item.status !== 'applied') continue;
        item.status = 'failed';
        item.error = `revision conflict — re-read and retry (current ${outcome.revision})`;
        for (const field of item.fields ?? []) {
          if (field.status === 'applied') {
            field.status = 'failed';
            field.error = `revision conflict — re-read and retry (current ${outcome.revision})`;
          }
        }
      }
      return { items: itemResults, revision: outcome.revision };
    }
    const effective: Record<string, unknown> = {};
    for (const field of allFields) {
      if (field.kind === 'secret') continue;
      const value = getPath(outcome.document, field.path);
      effective[field.path] = value !== undefined ? value : field.default;
    }
    deps.onChanged?.({
      owner: 'app',
      ids: validEntryIds,
      scope: 'host',
      revision: outcome.revision,
    });
    for (const item of itemResults) {
      if (item.status === 'applied') item.revision = outcome.revision;
    }
    void caller;
    return { items: itemResults, revision: outcome.revision, effective, document: outcome.document };
  };

  const updateApp = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    if (params.scope !== undefined) {
      throw new HarnessServiceError(
        'denied',
        `"${entry.id}" is host-owned; global/project scope is only valid for pi-settings entries`,
      );
    }
    const { items, revision, effective } = await updateAppBatch(
      caller,
      [{ entry, set: params.set ?? {}, reset: params.reset ?? [] }],
      params.expectedRevision,
    );
    const item = items[0]!;
    const fields = item.fields ?? [];
    return {
      status: item.status === 'applied'
        ? (fields.some((f) => f.status === 'failed') ? 'partial' : 'applied')
        : 'failed',
      entry: toSearchItem(entry),
      scope: 'host',
      fields,
      ...(revision ? { revision } : {}),
      appliedAt: entry.apply ?? 'immediate',
      ...(effective ? { effective } : {}),
    };
  };

  interface PiWrite {
    entry: SettingsCatalogEntry;
    set: Record<string, unknown>;
    reset: string[];
  }

  /**
   * Commit one or more pi-owner write specs at one scope in a single
   * `settings.update` call — the Pi authority's revision CAS covers the merged
   * top-level keys atomically.
   */
  const updatePiBatch = async (
    caller: SettingsServiceCaller,
    scope: 'global' | 'project',
    writes: PiWrite[],
    expectedRevision?: string,
  ): Promise<{ items: SettingsItemResult[]; revision?: string; effective?: Record<string, unknown> }> => {
    if (!caller.workspaceId) {
      throw new HarnessServiceError('unavailable', 'pi-settings updates require a workspace-bound session');
    }
    const root = await deps.resolveWorkspaceRoot(caller.workspaceId);
    if (!root) {
      throw new HarnessServiceError('unavailable', `cannot resolve workspace root for ${caller.workspaceId}`);
    }
    const itemResults: SettingsItemResult[] = [];
    const set: Record<string, unknown> = {};
    const remove: string[] = [];
    const validEntryIds: string[] = [];
    for (const write of writes) {
      const byPath = new Map(entryFields(write.entry).map((field) => [field.path, field]));
      const fieldResults: SettingsFieldResult[] = [];
      const itemSetPaths: string[] = [];
      const itemResetPaths: string[] = [];
      for (const [path, value] of Object.entries(write.set)) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential references are managed by Pi auth, not this service' });
          continue;
        }
        if (scope === 'project' && field.scope === 'user') {
          fieldResults.push({ path, status: 'failed', error: `"${path}" is user-owned and cannot be written at project scope` });
          continue;
        }
        const problem = validateFieldValue(field, value);
        if (problem) {
          fieldResults.push({ path, status: 'failed', error: problem });
          continue;
        }
        itemSetPaths.push(path);
        set[path] = value;
      }
      for (const path of write.reset) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential references are managed by Pi auth, not this service' });
          continue;
        }
        if (scope === 'project' && field.scope === 'user') {
          fieldResults.push({ path, status: 'failed', error: `"${path}" is user-owned and cannot be reset at project scope` });
          continue;
        }
        itemResetPaths.push(path);
        remove.push(path);
      }
      if (itemSetPaths.length === 0 && itemResetPaths.length === 0) {
        itemResults.push({
          id: write.entry.id, status: 'failed', fields: fieldResults, error: 'no valid fields to write',
        });
        continue;
      }
      validEntryIds.push(write.entry.id);
      itemResults.push({
        id: write.entry.id,
        status: 'applied',
        fields: [
          ...itemSetPaths.map((path): SettingsFieldResult => ({ path, status: 'applied' })),
          ...itemResetPaths.map((path): SettingsFieldResult => ({ path, status: 'applied' })),
          ...fieldResults,
        ],
      });
    }
    if (Object.keys(set).length === 0 && remove.length === 0) {
      return { items: itemResults };
    }
    // CAS: the pi authority pins the revision of the target scope file.
    let snapshot = await deps.requestPi(root, 'settings.get', {});
    const expected = expectedRevision
      ?? (scope === 'project' ? snapshot.projectRevision : snapshot.globalRevision);
    // settings.update applies top-level keys only — nested paths
    // (harness.shell, …) are grouped into a read-modify-write of their root
    // object inside the same CAS revision.
    const layer = scope === 'project' ? snapshot.project : snapshot.global;
    const rootSets = new Map<string, Record<string, unknown>>();
    for (const [path, value] of Object.entries(set)) {
      if (!path.includes('.')) continue;
      const rootKey = path.split('.')[0]!;
      const currentRoot = getPath(layer, rootKey);
      const rootObject = rootSets.get(rootKey)
        ?? (isRecord(currentRoot) ? structuredClone(currentRoot) : {});
      rootSets.set(rootKey, rootObject);
      setPath(rootObject, path.slice(rootKey.length + 1), value);
    }
    const nestedResets = new Map<string, string[]>();
    for (const path of remove) {
      if (!path.includes('.')) continue;
      const rootKey = path.split('.')[0]!;
      const currentRoot = getPath(layer, rootKey);
      const rootObject = rootSets.get(rootKey)
        ?? (isRecord(currentRoot) ? structuredClone(currentRoot) : {});
      rootSets.set(rootKey, rootObject);
      nestedResets.set(rootKey, [...(nestedResets.get(rootKey) ?? []), path.slice(rootKey.length + 1)]);
    }
    const topLevelSet: Record<string, unknown> = {};
    const topLevelRemove: string[] = [];
    for (const [path, value] of Object.entries(set)) {
      if (!path.includes('.')) topLevelSet[path] = value;
    }
    for (const path of remove) {
      if (!path.includes('.')) topLevelRemove.push(path);
    }
    for (const [rootKey, rootObject] of rootSets) {
      for (const sub of nestedResets.get(rootKey) ?? []) {
        deletePath(rootObject, sub);
      }
      topLevelSet[rootKey] = rootObject;
    }
    const updated = await deps.requestPi(root, 'settings.update', {
      scope,
      expectedRevision: expected,
      set: topLevelSet,
      remove: topLevelRemove,
    }).catch((error: unknown) => {
      throw new HarnessServiceError('failed', error instanceof Error ? error.message : String(error));
    });
    snapshot = updated;
    const revision = scope === 'project' ? snapshot.projectRevision : snapshot.globalRevision;
    const effective: Record<string, unknown> = {};
    for (const path of [...Object.keys(set), ...remove]) {
      const nextLayer = scope === 'project' ? snapshot.project : snapshot.global;
      effective[path] = getPath(nextLayer, path);
    }
    deps.onChanged?.({
      owner: 'pi-settings',
      ids: validEntryIds,
      scope,
      revision,
    });
    for (const item of itemResults) {
      if (item.status === 'applied') item.revision = revision;
    }
    return { items: itemResults, revision, effective };
  };

  const updatePi = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    const scope = params.scope ?? 'global';
    const { items, revision, effective } = await updatePiBatch(
      caller,
      scope,
      [{ entry, set: params.set ?? {}, reset: params.reset ?? [] }],
      params.expectedRevision,
    );
    const item = items[0]!;
    const fields = item.fields ?? [];
    return {
      status: item.status === 'applied'
        ? (fields.some((f) => f.status === 'failed') ? 'partial' : 'applied')
        : 'failed',
      entry: toSearchItem(entry),
      scope,
      fields,
      ...(revision ? { revision } : {}),
      appliedAt: entry.apply ?? 'next-run',
      ...(effective ? { effective } : {}),
    };
  };

  /**
   * `client` entries apply on the connected surface through the targeted
   * bridge — the surface's own store writes the value and reports the fact.
   */
  const updateClient = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams | SettingsUpdateItem,
  ): Promise<SettingsUpdateResult> => {
    const bridge = deps.clientSurfaces;
    if (!bridge) {
      throw new HarnessServiceError(
        'unavailable',
        `"${entry.id}" is device-local and no surface channel is registered on this host`,
      );
    }
    let response;
    try {
      response = await bridge.request({
        type: 'apply',
        entries: [{
          id: entry.id,
          values: {
            ...(params.set ?? {}),
            ...(params.reset ?? []).reduce<Record<string, unknown>>((acc, path) => {
              acc[path] = null;
              return acc;
            }, {}),
          },
        }],
        ...(params.surface ? { surfaceId: params.surface } : {}),
      });
    } catch (error) {
      const code = error instanceof HarnessServiceError ? error.harnessCode : undefined;
      throw new HarnessServiceError(
        code === 'ambiguous' ? 'denied' : 'unavailable',
        error instanceof Error ? error.message : String(error),
      );
    }
    const result = response.results.find((item) => item.id === entry.id);
    const status = result?.status ?? 'unavailable';
    deps.onChanged?.({
      owner: 'client',
      ids: [entry.id],
      scope: 'client',
      revision: `surface:${response.surface.id}`,
    });
    return {
      status: status === 'applied' ? 'applied' : status === 'failed' ? 'failed' : 'failed',
      entry: toSearchItem(entry),
      scope: 'client',
      fields: [{ path: entry.id, status: status === 'applied' ? 'applied' : 'failed', ...(result?.error ? { error: result.error } : {}) }],
      appliedAt: entry.apply ?? 'immediate',
      surface: {
        id: response.surface.id,
        kind: response.surface.kind,
        results: (result ? [{ path: entry.id, status, ...(result.error ? { error: result.error } : {}) }] : []),
      },
      revision: `surface:${response.surface.id}`,
    };
  };

  /**
   * Compound update: validate every item, then execute per owner group.
   * Same-owner app items land in one CAS write; pi-settings merge per scope;
   * client items go to the resolved surface in one request; action entries
   * are reported as needing `settings.action`. Per-item results keep partial
   * success visible — no fake global transaction is implied.
   */
  const updateCompound = async (
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    const items = params.items ?? [];
    const itemResults: SettingsItemResult[] = [];
    const appWrites: { entry: SettingsCatalogEntry; set: Record<string, unknown>; reset: string[] }[] = [];
    const piByScope = new Map<'global' | 'project', { entry: SettingsCatalogEntry; set: Record<string, unknown>; reset: string[] }[]>();
    const clientBySurface = new Map<
      string | undefined,
      { entry: SettingsCatalogEntry; values: Record<string, unknown> }[]
    >();

    for (const item of items) {
      const entry = getSettingsCatalogEntry(item.id);
      if (!entry) {
        itemResults.push({ id: item.id, status: 'failed', error: `unknown settings id "${item.id}"` });
        continue;
      }
      switch (entry.owner) {
        case 'app':
          appWrites.push({ entry, set: item.set ?? {}, reset: item.reset ?? [] });
          break;
        case 'pi-settings': {
          const scope = item.scope ?? 'global';
          const list = piByScope.get(scope) ?? [];
          list.push({ entry, set: item.set ?? {}, reset: item.reset ?? [] });
          piByScope.set(scope, list);
          break;
        }
        case 'client': {
          const surfaceKey = item.surface ?? params.surface;
          const list = clientBySurface.get(surfaceKey) ?? [];
          list.push({
            entry,
            values: {
              ...(item.set ?? {}),
              ...(item.reset ?? []).reduce<Record<string, unknown>>((acc, path) => {
                acc[path] = null;
                return acc;
              }, {}),
            },
          });
          clientBySurface.set(surfaceKey, list);
          break;
        }
        case 'action':
        default:
          itemResults.push({
            id: item.id,
            status: 'failed',
            error: `"${item.id}" is a domain action — invoke it through settings.action`,
          });
      }
    }

    if (appWrites.length > 0) {
      const batch = await updateAppBatch(
        caller,
        appWrites,
        params.expectedRevision,
      );
      itemResults.push(...batch.items);
    }
    for (const [scope, writes] of piByScope) {
      const batch = await updatePiBatch(caller, scope, writes, params.expectedRevision);
      itemResults.push(...batch.items);
    }
    for (const [surfaceKey, clientEntries] of clientBySurface) {
      const bridge = deps.clientSurfaces;
      if (!bridge) {
        for (const { entry } of clientEntries) {
          itemResults.push({ id: entry.id, status: 'unavailable', error: 'no surface channel is registered on this host' });
        }
        continue;
      }
      try {
        const response = await bridge.request({
          type: 'apply',
          entries: clientEntries.map(({ entry, values }) => ({ id: entry.id, values })),
          ...(surfaceKey ? { surfaceId: surfaceKey } : {}),
        });
        for (const { entry } of clientEntries) {
          const result = response.results.find((item) => item.id === entry.id);
          itemResults.push({
            id: entry.id,
            status: result?.status === 'applied' ? 'applied' : result?.status === 'failed' ? 'failed' : 'unavailable',
            ...(result?.error ? { error: result.error } : {}),
          });
        }
        deps.onChanged?.({
          owner: 'client',
          ids: clientEntries.map(({ entry }) => entry.id),
          scope: 'client',
          revision: `surface:${response.surface.id}`,
        });
      } catch (error) {
        for (const { entry } of clientEntries) {
          itemResults.push({
            id: entry.id,
            status: 'unavailable',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const firstKnown = getSettingsCatalogEntry(items[0]?.id ?? params.id)
      ?? items.map((item) => getSettingsCatalogEntry(item.id)).find((entry) => entry !== undefined);
    if (!firstKnown && itemResults.length === 0) {
      throw new HarnessServiceError('not-found', 'compound update had no known settings ids');
    }
    const failed = itemResults.filter((item) => item.status === 'failed' || item.status === 'unavailable');
    return {
      status: itemResults.length === 0
        ? 'failed'
        : failed.length === itemResults.length
          ? 'failed'
          : failed.length > 0 ? 'partial' : 'applied',
      entry: firstKnown
        ? toSearchItem(firstKnown)
        : { id: items[0]?.id ?? params.id, category: '', owner: 'app', titleKey: '', paths: [], writable: false, page: '' },
      scope: 'host',
      fields: [],
      appliedAt: 'immediate',
      items: itemResults,
    };
  };

  const update = async (
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    if (params.items && params.items.length > 0) {
      return updateCompound(caller, params);
    }
    const entry = requireEntry(params.id);
    switch (entry.owner) {
      case 'app':
        return updateApp(entry, caller, params);
      case 'pi-settings':
        return updatePi(entry, caller, params);
      case 'client':
        return updateClient(entry, caller, params);
      case 'action':
      default:
        throw new HarnessServiceError(
          'denied',
          `"${entry.id}" is a domain action (${entry.actionRef?.domain ?? 'unknown'}) — invoke it through settings.action`,
        );
    }
  };

  return { search, read, update, action: invokeAction };
}

export { listSettingsCategories };
