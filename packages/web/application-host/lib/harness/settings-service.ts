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
  SettingsFieldResult,
  SettingsFieldValue,
  SettingsReadParams,
  SettingsReadResult,
  SettingsSearchItem,
  SettingsSearchParams,
  SettingsSearchResult,
  SettingsUpdateParams,
  SettingsUpdateResult,
} from '@piarium/protocol';
import { mergeHarnessSettings } from '@piarium/protocol';
import { HarnessServiceError } from './service-error.js';
import type { PiariumSettingsDocument } from '@piarium/settings-store';

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
  /** Fires once per successful write with the affected catalog ids. */
  onChanged?(change: {
    owner: 'app' | 'pi-settings';
    ids: string[];
    scope: 'host' | 'global' | 'project';
    revision: string;
  }): void;
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
  search(params: SettingsSearchParams): SettingsSearchResult;
  read(caller: SettingsServiceCaller, params: SettingsReadParams): Promise<SettingsReadResult>;
  update(caller: SettingsServiceCaller, params: SettingsUpdateParams): Promise<SettingsUpdateResult>;
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const search = (params: SettingsSearchParams): SettingsSearchResult => {
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
    return {
      items: matches.slice(offset, offset + limit).map(toSearchItem),
      total: matches.length,
      categories: [...categories.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    };
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
        return {
          state: 'unavailable',
          entry: toSearchItem(entry),
          reason: 'device-local preference owned by the connected surface — change it in that client\'s settings UI',
        };
      case 'action':
      default:
        return {
          state: 'action',
          entry: toSearchItem(entry),
          ...(entry.actionRef ? {
            action: {
              domain: entry.actionRef.domain,
              ...(entry.actionRef.verbs ? { verbs: [...entry.actionRef.verbs] } : {}),
              ...(entry.actionRef.note ? { note: entry.actionRef.note } : {}),
            },
          } : {}),
          ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
        };
    }
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
    const fields = entryFields(entry);
    const byPath = new Map(fields.map((field) => [field.path, field]));
    const fieldResults: SettingsFieldResult[] = [];
    const setEntries = Object.entries(params.set ?? {});
    const resetPaths = params.reset ?? [];
    const validSets: [string, unknown][] = [];
    const validResets: string[] = [];
    for (const [path, value] of setEntries) {
      const field = byPath.get(path);
      if (!field) {
        fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${entry.id}` });
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
      validSets.push([path, value]);
    }
    for (const path of resetPaths) {
      const field = byPath.get(path);
      if (!field) {
        fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${entry.id}` });
        continue;
      }
      if (field.kind === 'secret') {
        fieldResults.push({ path, status: 'failed', error: 'credential fields cannot be reset through this service' });
        continue;
      }
      validResets.push(path);
    }
    if (validSets.length === 0 && validResets.length === 0) {
      return {
        status: 'failed',
        entry: toSearchItem(entry),
        scope: 'host',
        fields: fieldResults,
        appliedAt: entry.apply ?? 'immediate',
      };
    }
    // Nested paths (fileEditorSettings.*) collapse into their top-level key —
    // the persist pipeline merges whole top-level objects, so a partial nested
    // write must read-modify-write its root inside the CAS revision.
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
      params.expectedRevision ?? settingsDocumentRevision(current),
    );
    if (outcome.conflict) {
      for (const [path] of validSets) {
        fieldResults.push({ path, status: 'failed', error: `revision conflict — re-read and retry (current ${outcome.revision})` });
      }
      for (const path of validResets) {
        fieldResults.push({ path, status: 'failed', error: `revision conflict — re-read and retry (current ${outcome.revision})` });
      }
      return {
        status: 'failed',
        entry: toSearchItem(entry),
        scope: 'host',
        fields: fieldResults,
        appliedAt: entry.apply ?? 'immediate',
        revision: outcome.revision,
      };
    }
    for (const [path] of validSets) fieldResults.push({ path, status: 'applied' });
    for (const path of validResets) fieldResults.push({ path, status: 'applied' });
    const effective: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.kind === 'secret') continue;
      const value = getPath(outcome.document, field.path);
      effective[field.path] = value !== undefined ? value : field.default;
    }
    deps.onChanged?.({
      owner: 'app',
      ids: [entry.id],
      scope: 'host',
      revision: outcome.revision,
    });
    return {
      status: fieldResults.some((result) => result.status === 'failed') ? 'partial' : 'applied',
      entry: toSearchItem(entry),
      scope: 'host',
      fields: fieldResults,
      revision: outcome.revision,
      appliedAt: entry.apply ?? 'immediate',
      effective,
    };
  };

  const updatePi = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    const scope = params.scope ?? 'global';
    if (!caller.workspaceId) {
      throw new HarnessServiceError('unavailable', 'pi-settings updates require a workspace-bound session');
    }
    const root = await deps.resolveWorkspaceRoot(caller.workspaceId);
    if (!root) {
      throw new HarnessServiceError('unavailable', `cannot resolve workspace root for ${caller.workspaceId}`);
    }
    const fields = entryFields(entry);
    const byPath = new Map(fields.map((field) => [field.path, field]));
    const fieldResults: SettingsFieldResult[] = [];
    const set: Record<string, unknown> = {};
    const remove: string[] = [];
    for (const [path, value] of Object.entries(params.set ?? {})) {
      const field = byPath.get(path);
      if (!field) {
        fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${entry.id}` });
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
      set[path] = value;
    }
    for (const path of params.reset ?? []) {
      const field = byPath.get(path);
      if (!field) {
        fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${entry.id}` });
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
      remove.push(path);
    }
    if (Object.keys(set).length === 0 && remove.length === 0) {
      return {
        status: 'failed',
        entry: toSearchItem(entry),
        scope,
        fields: fieldResults,
        appliedAt: entry.apply ?? 'next-run',
      };
    }
    // CAS: the pi authority pins the revision of the target scope file.
    let snapshot = await deps.requestPi(root, 'settings.get', {});
    const expected = params.expectedRevision
      ?? (scope === 'project' ? snapshot.projectRevision : snapshot.globalRevision);
    // settings.update applies top-level keys only — nested paths
    // (harness.shell, …) are grouped into a read-modify-write of their root
    // object inside the same CAS revision.
    const layer = scope === 'project' ? snapshot.project : snapshot.global;
    const rootSets = new Map<string, Record<string, unknown>>();
    for (const [path, value] of Object.entries(set)) {
      const rootKey = path.split('.')[0]!;
      if (!path.includes('.')) {
        set[path] = value; // already top-level — handled below
        continue;
      }
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
    for (const path of Object.keys(set)) fieldResults.push({ path, status: 'applied' });
    for (const path of remove) fieldResults.push({ path, status: 'applied' });
    const effective: Record<string, unknown> = {};
    for (const path of [...Object.keys(set), ...remove]) {
      const layer = scope === 'project' ? snapshot.project : snapshot.global;
      effective[path] = getPath(layer, path);
    }
    deps.onChanged?.({
      owner: 'pi-settings',
      ids: [entry.id],
      scope,
      revision: scope === 'project' ? snapshot.projectRevision : snapshot.globalRevision,
    });
    return {
      status: fieldResults.some((result) => result.status === 'failed') ? 'partial' : 'applied',
      entry: toSearchItem(entry),
      scope,
      fields: fieldResults,
      revision: scope === 'project' ? snapshot.projectRevision : snapshot.globalRevision,
      appliedAt: entry.apply ?? 'next-run',
      effective,
    };
  };

  const update = async (
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    const entry = requireEntry(params.id);
    switch (entry.owner) {
      case 'app':
        return updateApp(entry, caller, params);
      case 'pi-settings':
        return updatePi(entry, caller, params);
      case 'client':
        throw new HarnessServiceError('denied', `"${entry.id}" is device-local — it can only be changed on the surface that owns it`);
      case 'action':
      default:
        throw new HarnessServiceError('denied', `"${entry.id}" is a domain action (${entry.actionRef?.domain ?? 'unknown'}), not a stored field — invoke the owning domain operation`);
    }
  };

  return { search, read, update };
}

export { listSettingsCategories };
