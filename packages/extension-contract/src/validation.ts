import {
  PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION,
  PIARIUM_EXTENSION_MANIFEST_SCHEMA_VERSION,
  type JsonObject,
  type JsonValue,
  type PiariumApplicationSurface,
  type PiariumExtensionActivationEvent,
  type PiariumExtensionActualState,
  type PiariumExtensionActualStatus,
  type PiariumExtensionAssetPayload,
  type PiariumExtensionAssetRequest,
  type PiariumExtensionCandidateRecord,
  type PiariumExtensionCandidatePreparationResult,
  type PiariumExtensionCandidateSelectionRequest,
  type PiariumExtensionCatalogAvailability,
  type PiariumExtensionCatalogDocument,
  type PiariumExtensionCatalogEntry,
  type PiariumExtensionCatalogSnapshot,
  type PiariumExtensionCapabilityGrant,
  type PiariumExtensionContributionKind,
  type PiariumExtensionDesiredState,
  type PiariumExtensionDiagnostic,
  type PiariumExtensionHostEntrypoint,
  type PiariumExtensionHostIdentityDocument,
  type PiariumExtensionHostStateSnapshot,
  type PiariumExtensionHostStateWaitRequest,
  type PiariumExtensionInstallationRecord,
  type PiariumExtensionManifest,
  type PiariumExtensionManagedEntrypointPayload,
  type PiariumExtensionManagedEntrypointRequest,
  type PiariumExtensionPackageSource,
  type PiariumExtensionPackageInstallRequest,
  type PiariumExtensionServiceProvision,
  type PiariumExtensionServiceCatalogSnapshot,
  type PiariumExtensionServiceInvocationRequest,
  type PiariumExtensionServiceProviderSnapshot,
  type PiariumExtensionServiceSelectionRequest,
  type PiariumExtensionServiceRequirement,
  type PiariumExtensionStaticContribution,
  type PiariumExtensionStorageAddress,
  type PiariumExtensionStorageDocument,
  type PiariumExtensionStorageSnapshot,
  type PiariumExtensionSurfaceEntrypoint,
} from "./types.js";

const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ENTRY_PATH_PATTERN = /^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\0).+$/;
const INTEGRITY_PATTERN = /^sha256-[0-9a-f]{64}$/;

const HOST_MODES = new Set(["brokered", "native"]);
const SURFACE_MODES = new Set(["declarative", "isolated", "managed", "native"]);
const SURFACES = new Set<PiariumApplicationSurface>(["desktop", "mobile", "vscode", "web"]);
const ACTIVATION_EVENTS = new Set<PiariumExtensionActivationEvent>([
  "application-startup",
  "background",
  "command",
  "contribution-visible",
  "service-request",
  "workspace-match",
]);
const CONTRIBUTION_KINDS = new Set<PiariumExtensionContributionKind>([
  "command",
  "composer-action",
  "keybinding",
  "menu-item",
  "message-renderer",
  "page",
  "panel",
  "session-decoration",
  "settings-page",
  "shell",
  "sidebar",
  "status-item",
  "tool-renderer",
]);
const SOURCE_KINDS = new Set(["builtin", "git", "local", "npm"]);
const ACTUAL_STATUSES = new Set<PiariumExtensionActualStatus>([
  "active",
  "activating",
  "deactivating",
  "failed",
  "inactive",
  "loading",
  "resolving",
  "rolling-back",
  "updating",
  "waiting",
]);
const STORAGE_STATES = new Set(["missing", "ready", "stale"]);

export class PiariumExtensionContractError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "PiariumExtensionContractError";
    this.issues = issues;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function timestamp(value: unknown, path: string, issues: string[]): string {
  const normalized = text(value);
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    issues.push(`${path} must be an ISO timestamp`);
    return new Date(0).toISOString();
  }
  return normalized;
}

function positiveRevision(value: unknown, path: string, issues: string[], allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) {
    issues.push(`${path} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
    return allowZero ? 0 : 1;
  }
  return Number(value);
}

function identifier(value: unknown, path: string, issues: string[]): string {
  const normalized = text(value);
  if (!normalized || !ID_PATTERN.test(normalized)) {
    issues.push(`${path} must be a lowercase namespaced identifier`);
    return "invalid";
  }
  return normalized;
}

function integrity(value: unknown, path: string, issues: string[]): string {
  const normalized = text(value);
  if (!normalized || !INTEGRITY_PATTERN.test(normalized)) {
    issues.push(`${path} must be a lowercase sha256 integrity value`);
    return `sha256-${"0".repeat(64)}`;
  }
  return normalized;
}

function entryPath(value: unknown, path: string, issues: string[]): string {
  const normalized = text(value);
  if (!normalized || !ENTRY_PATH_PATTERN.test(normalized)) {
    issues.push(`${path} must be a forward-slash relative path without parent traversal`);
    return "invalid";
  }
  return normalized;
}

function uniqueStrings(value: unknown, path: string, issues: string[], id = false): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = id ? identifier(value[index], `${path}[${index}]`, issues) : text(value[index]);
    if (!item) {
      if (!id) issues.push(`${path}[${index}] must be a non-empty string`);
      continue;
    }
    if (seen.has(item)) {
      issues.push(`${path} contains duplicate value ${item}`);
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function jsonValue(value: unknown, path: string, issues: string[]): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`, issues));
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) result[key] = jsonValue(item, `${path}.${key}`, issues);
    return result;
  }
  issues.push(`${path} must contain only JSON values`);
  return null;
}

function activation(value: unknown, path: string, issues: string[]): PiariumExtensionActivationEvent[] | undefined {
  if (value === undefined) return undefined;
  const values = uniqueStrings(value, path, issues);
  const result: PiariumExtensionActivationEvent[] = [];
  for (const item of values) {
    if (!ACTIVATION_EVENTS.has(item as PiariumExtensionActivationEvent)) issues.push(`${path} contains unsupported event ${item}`);
    else result.push(item as PiariumExtensionActivationEvent);
  }
  return result;
}

function entryFile(value: unknown, path: string, issues: string[], required: boolean): string | undefined {
  const normalized = text(value);
  if (!normalized) {
    if (required) issues.push(`${path} is required`);
    return undefined;
  }
  if (!ENTRY_PATH_PATTERN.test(normalized)) issues.push(`${path} must be a relative forward-slash path without parent traversal`);
  return normalized;
}

function parseHostEntrypoint(value: unknown, path: string, issues: string[]): PiariumExtensionHostEntrypoint | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const mode = text(value.mode);
  if (!mode || !HOST_MODES.has(mode)) issues.push(`${path}.mode must be brokered or native`);
  const file = entryFile(value.file, `${path}.file`, issues, true) ?? "invalid";
  const activationEvents = activation(value.activation, `${path}.activation`, issues);
  return {
    file,
    mode: mode === "native" ? "native" : "brokered",
    ...(activationEvents ? { activation: activationEvents } : {}),
  };
}

function parseSurfaceEntrypoints(value: unknown, path: string, issues: string[]): PiariumExtensionSurfaceEntrypoint[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return undefined;
  }
  const result: PiariumExtensionSurfaceEntrypoint[] = [];
  const ids = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    const id = identifier(raw.id, `${itemPath}.id`, issues);
    if (ids.has(id)) issues.push(`${path} contains duplicate entrypoint ${id}`);
    ids.add(id);
    const mode = text(raw.mode);
    if (!mode || !SURFACE_MODES.has(mode)) issues.push(`${itemPath}.mode is unsupported`);
    const file = entryFile(raw.file, `${itemPath}.file`, issues, mode !== "declarative");
    const rawSupports = uniqueStrings(raw.supports, `${itemPath}.supports`, issues);
    const supports: PiariumApplicationSurface[] = [];
    for (const surface of rawSupports) {
      if (!SURFACES.has(surface as PiariumApplicationSurface)) issues.push(`${itemPath}.supports contains unsupported surface ${surface}`);
      else supports.push(surface as PiariumApplicationSurface);
    }
    if (supports.length === 0) issues.push(`${itemPath}.supports must contain at least one surface`);
    const activationEvents = activation(raw.activation, `${itemPath}.activation`, issues);
    result.push({
      id,
      mode: SURFACE_MODES.has(mode ?? "") ? mode as PiariumExtensionSurfaceEntrypoint["mode"] : "managed",
      supports,
      ...(file ? { file } : {}),
      ...(activationEvents ? { activation: activationEvents } : {}),
    });
  });
  return result;
}

function parseServices<T extends PiariumExtensionServiceRequirement | PiariumExtensionServiceProvision>(
  value: unknown,
  path: string,
  issues: string[],
  kind: "provide" | "require",
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return undefined;
  }
  const result: T[] = [];
  const keys = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    const id = identifier(raw.id, `${itemPath}.id`, issues);
    const version = positiveRevision(raw.version, `${itemPath}.version`, issues);
    const key = `${id}@${version}`;
    if (keys.has(key)) issues.push(`${path} contains duplicate service ${key}`);
    keys.add(key);
    const flagKey = kind === "provide" ? "multiple" : "optional";
    const flag = raw[flagKey];
    if (flag !== undefined && typeof flag !== "boolean") issues.push(`${itemPath}.${flagKey} must be boolean`);
    const binding = kind === "require" && (raw.binding === "all" || raw.binding === "selected" || raw.binding === "single")
      ? raw.binding
      : undefined;
    if (kind === "require" && raw.binding !== undefined && !binding) issues.push(`${itemPath}.binding must be all, selected, or single`);
    result.push({
      id,
      version,
      ...(typeof flag === "boolean" ? { [flagKey]: flag } : {}),
      ...(binding ? { binding } : {}),
    } as T);
  });
  return result;
}

function parseContributions(value: unknown, path: string, issues: string[]): PiariumExtensionStaticContribution[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return undefined;
  }
  const result: PiariumExtensionStaticContribution[] = [];
  const ids = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    const id = identifier(raw.id, `${itemPath}.id`, issues);
    if (ids.has(id)) issues.push(`${path} contains duplicate contribution ${id}`);
    ids.add(id);
    const kind = text(raw.kind);
    if (!kind || !CONTRIBUTION_KINDS.has(kind as PiariumExtensionContributionKind)) issues.push(`${itemPath}.kind is unsupported`);
    const data = isRecord(raw.data) ? jsonValue(raw.data, `${itemPath}.data`, issues) as JsonObject : {};
    if (!isRecord(raw.data)) issues.push(`${itemPath}.data must be an object`);
    const contractVersion = positiveRevision(raw.contractVersion, `${itemPath}.contractVersion`, issues);
    const rawSupports = uniqueStrings(raw.supports, `${itemPath}.supports`, issues);
    const supports: PiariumApplicationSurface[] = [];
    for (const surface of rawSupports) {
      if (!SURFACES.has(surface as PiariumApplicationSurface)) issues.push(`${itemPath}.supports contains unsupported surface ${surface}`);
      else supports.push(surface as PiariumApplicationSurface);
    }
    if (supports.length === 0) issues.push(`${itemPath}.supports must contain at least one surface`);
    const entrypoint = raw.entrypoint === undefined ? undefined : identifier(raw.entrypoint, `${itemPath}.entrypoint`, issues);
    const requiresCapabilities = uniqueStrings(raw.requiresCapabilities, `${itemPath}.requiresCapabilities`, issues, true);
    let placement: PiariumExtensionStaticContribution["placement"];
    if (raw.placement !== undefined) {
      if (!isRecord(raw.placement)) {
        issues.push(`${itemPath}.placement must be an object`);
      } else {
        const order = raw.placement.order;
        if (order !== undefined && (typeof order !== "number" || !Number.isFinite(order))) issues.push(`${itemPath}.placement.order must be finite`);
        const slot = raw.placement.slot === undefined ? undefined : identifier(raw.placement.slot, `${itemPath}.placement.slot`, issues);
        placement = {
          ...(slot ? { slot } : {}),
          ...(typeof order === "number" && Number.isFinite(order) ? { order } : {}),
          ...(raw.placement.before !== undefined ? { before: uniqueStrings(raw.placement.before, `${itemPath}.placement.before`, issues, true) } : {}),
          ...(raw.placement.after !== undefined ? { after: uniqueStrings(raw.placement.after, `${itemPath}.placement.after`, issues, true) } : {}),
        };
      }
    }
    let replacement: PiariumExtensionStaticContribution["replacement"];
    if (raw.replacement !== undefined) {
      if (!isRecord(raw.replacement)) {
        issues.push(`${itemPath}.replacement must be an object`);
      } else {
        const target = identifier(raw.replacement.target, `${itemPath}.replacement.target`, issues);
        const priority = raw.replacement.priority;
        if (priority !== undefined && (typeof priority !== "number" || !Number.isFinite(priority))) issues.push(`${itemPath}.replacement.priority must be finite`);
        replacement = {
          target,
          ...(typeof priority === "number" && Number.isFinite(priority) ? { priority } : {}),
        };
      }
    }
    result.push({
      id,
      kind: CONTRIBUTION_KINDS.has(kind as PiariumExtensionContributionKind) ? kind as PiariumExtensionContributionKind : "page",
      contractVersion,
      data,
      supports,
      ...(entrypoint ? { entrypoint } : {}),
      ...(requiresCapabilities.length > 0 ? { requiresCapabilities } : {}),
      ...(placement ? { placement } : {}),
      ...(replacement ? { replacement } : {}),
      ...(text(raw.title) ? { title: text(raw.title) as string } : {}),
      ...(text(raw.when) ? { when: text(raw.when) as string } : {}),
    });
  });
  return result;
}

function throwIssues(label: string, issues: string[]): void {
  if (issues.length > 0) throw new PiariumExtensionContractError(`${label} is invalid`, issues);
}

function hostId(value: unknown, path: string, issues: string[]): string {
  const normalized = text(value);
  if (!normalized || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    issues.push(`${path} must be a UUID`);
    return "00000000-0000-4000-8000-000000000000";
  }
  return normalized;
}

export function parsePiariumExtensionManifest(value: unknown): PiariumExtensionManifest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension manifest is invalid", ["manifest must be an object"]);
  if (value.schemaVersion !== PIARIUM_EXTENSION_MANIFEST_SCHEMA_VERSION) issues.push("schemaVersion must be 1");
  const id = identifier(value.id, "id", issues);
  const version = text(value.version) ?? "0.0.0";
  if (!SEMVER_PATTERN.test(version)) issues.push("version must be a SemVer version");
  const rawEngines = isRecord(value.engines) ? value.engines : {};
  if (!isRecord(value.engines)) issues.push("engines must be an object");
  const piariumEngine = text(rawEngines.piarium) ?? "*";
  if (!text(rawEngines.piarium)) issues.push("engines.piarium must be a non-empty compatibility range");

  const rawEntrypoints = value.entrypoints;
  if (rawEntrypoints !== undefined && !isRecord(rawEntrypoints)) issues.push("entrypoints must be an object");
  const entrypointsRecord = isRecord(rawEntrypoints) ? rawEntrypoints : {};
  const host = parseHostEntrypoint(entrypointsRecord.host, "entrypoints.host", issues);
  const surfaces = parseSurfaceEntrypoints(entrypointsRecord.surfaces, "entrypoints.surfaces", issues);

  const rawRequires = isRecord(value.requires) ? value.requires : {};
  if (value.requires !== undefined && !isRecord(value.requires)) issues.push("requires must be an object");
  const requiredServices = parseServices<PiariumExtensionServiceRequirement>(rawRequires.services, "requires.services", issues, "require");
  const rawProvides = isRecord(value.provides) ? value.provides : {};
  if (value.provides !== undefined && !isRecord(value.provides)) issues.push("provides must be an object");
  const providedServices = parseServices<PiariumExtensionServiceProvision>(rawProvides.services, "provides.services", issues, "provide");

  const rawCapabilities = isRecord(value.capabilities) ? value.capabilities : {};
  if (value.capabilities !== undefined && !isRecord(value.capabilities)) issues.push("capabilities must be an object");
  const hostCapabilities = uniqueStrings(rawCapabilities.host, "capabilities.host", issues, true);
  const surfaceCapabilities = uniqueStrings(rawCapabilities.surface, "capabilities.surface", issues, true);
  const rawIntegrates = isRecord(value.integrates) ? value.integrates : {};
  if (value.integrates !== undefined && !isRecord(value.integrates)) issues.push("integrates must be an object");
  const piPackages = uniqueStrings(rawIntegrates.piPackages, "integrates.piPackages", issues);
  const contributions = parseContributions(value.contributions, "contributions", issues);
  let storageSchemaVersion: number | undefined;
  if (value.storage !== undefined) {
    if (!isRecord(value.storage)) issues.push("storage must be an object");
    else storageSchemaVersion = positiveRevision(value.storage.schemaVersion, "storage.schemaVersion", issues);
  }
  const surfaceById = new Map((surfaces ?? []).map((surface) => [surface.id, surface]));
  for (const contribution of contributions ?? []) {
    if (!contribution.id.startsWith(`${id}.`)) issues.push(`contribution ${contribution.id} must be qualified by extension ID ${id}`);
    if (contribution.entrypoint) {
      const surface = surfaceById.get(contribution.entrypoint);
      if (!surface) issues.push(`contribution ${contribution.id} references unknown surface entrypoint ${contribution.entrypoint}`);
      else {
        for (const supported of contribution.supports) {
          if (!surface.supports.includes(supported)) issues.push(`contribution ${contribution.id} supports ${supported} but entrypoint ${surface.id} does not`);
        }
      }
    }
    for (const capability of contribution.requiresCapabilities ?? []) {
      if (!surfaceCapabilities.includes(capability)) issues.push(`contribution ${contribution.id} requires undeclared surface capability ${capability}`);
    }
  }
  throwIssues("Piarium extension manifest", issues);

  return {
    schemaVersion: PIARIUM_EXTENSION_MANIFEST_SCHEMA_VERSION,
    id,
    version,
    engines: { piarium: piariumEngine },
    ...(text(value.displayName) ? { displayName: text(value.displayName) as string } : {}),
    ...(host || surfaces ? { entrypoints: { ...(host ? { host } : {}), ...(surfaces ? { surfaces } : {}) } } : {}),
    ...(requiredServices ? { requires: { services: requiredServices } } : {}),
    ...(providedServices ? { provides: { services: providedServices } } : {}),
    ...(hostCapabilities.length > 0 || surfaceCapabilities.length > 0 ? {
      capabilities: {
        ...(hostCapabilities.length > 0 ? { host: hostCapabilities } : {}),
        ...(surfaceCapabilities.length > 0 ? { surface: surfaceCapabilities } : {}),
      },
    } : {}),
    ...(piPackages.length > 0 ? { integrates: { piPackages } } : {}),
    ...(contributions ? { contributions } : {}),
    ...(storageSchemaVersion !== undefined ? { storage: { schemaVersion: storageSchemaVersion } } : {}),
  };
}

function parseSource(value: unknown, path: string, issues: string[]): PiariumExtensionPackageSource {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return { display: "Invalid source", kind: "local", specifier: "invalid" };
  }
  const kind = text(value.kind);
  if (!kind || !SOURCE_KINDS.has(kind)) issues.push(`${path}.kind is unsupported`);
  const display = text(value.display);
  const specifier = text(value.specifier);
  if (!display) issues.push(`${path}.display must be a non-empty string`);
  if (!specifier) issues.push(`${path}.specifier must be a non-empty string`);
  return {
    kind: SOURCE_KINDS.has(kind ?? "") ? kind as PiariumExtensionPackageSource["kind"] : "local",
    display: display ?? "Invalid source",
    specifier: specifier ?? "invalid",
  };
}

function parseDesired(value: unknown, path: string, issues: string[]): PiariumExtensionDesiredState {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return { enabled: false, revision: 1, updatedAt: new Date(0).toISOString() };
  }
  if (typeof value.enabled !== "boolean") issues.push(`${path}.enabled must be boolean`);
  return {
    enabled: value.enabled === true,
    revision: positiveRevision(value.revision, `${path}.revision`, issues),
    updatedAt: timestamp(value.updatedAt, `${path}.updatedAt`, issues),
  };
}

function parseGrants(value: unknown, path: string, issues: string[]): PiariumExtensionCapabilityGrant[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  const seen = new Set<string>();
  const result: PiariumExtensionCapabilityGrant[] = [];
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    const capability = identifier(raw.capability, `${itemPath}.capability`, issues);
    const realm = raw.realm === "host" || raw.realm === "surface" ? raw.realm : undefined;
    if (!realm) issues.push(`${itemPath}.realm must be host or surface`);
    const grantKey = `${realm ?? "invalid"}:${capability}`;
    if (seen.has(grantKey)) issues.push(`${path} contains duplicate capability ${grantKey}`);
    seen.add(grantKey);
    if (typeof raw.granted !== "boolean") issues.push(`${itemPath}.granted must be boolean`);
    const manifestVersion = text(raw.manifestVersion) ?? "0.0.0";
    if (!SEMVER_PATTERN.test(manifestVersion)) issues.push(`${itemPath}.manifestVersion must be SemVer`);
    result.push({
      capability,
      granted: raw.granted === true,
      manifestVersion,
      realm: realm ?? "surface",
      updatedAt: timestamp(raw.updatedAt, `${itemPath}.updatedAt`, issues),
    });
  });
  return result;
}

function parseCandidateRecord(value: unknown, path: string, issues: string[]): PiariumExtensionCandidateRecord | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  let manifest: PiariumExtensionManifest;
  try {
    manifest = parsePiariumExtensionManifest(value.manifest);
  } catch (error) {
    if (error instanceof PiariumExtensionContractError) issues.push(...error.issues.map((issue) => `${path}.manifest.${issue}`));
    manifest = { schemaVersion: 1, id: "invalid", version: "0.0.0", engines: { piarium: "*" } };
  }
  const resolvedVersion = text(value.resolvedVersion) ?? "0.0.0";
  if (!SEMVER_PATTERN.test(resolvedVersion)) issues.push(`${path}.resolvedVersion must be SemVer`);
  if (resolvedVersion !== manifest.version) issues.push(`${path}.resolvedVersion must match manifest.version`);
  const resolvedPath = text(value.resolvedPath);
  if (!resolvedPath) issues.push(`${path}.resolvedPath must be a non-empty string`);
  return {
    integrity: integrity(value.integrity, `${path}.integrity`, issues),
    manifest,
    preparedAt: timestamp(value.preparedAt, `${path}.preparedAt`, issues),
    resolvedPath: resolvedPath ?? "invalid",
    resolvedVersion,
    source: parseSource(value.source, `${path}.source`, issues),
  };
}

export function parsePiariumExtensionInstallationRecord(value: unknown, path = "installation"): PiariumExtensionInstallationRecord {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension installation is invalid", [`${path} must be an object`]);
  let manifest: PiariumExtensionManifest;
  try {
    manifest = parsePiariumExtensionManifest(value.manifest);
  } catch (error) {
    if (error instanceof PiariumExtensionContractError) issues.push(...error.issues.map((issue) => `${path}.manifest.${issue}`));
    manifest = { schemaVersion: 1, id: "invalid", version: "0.0.0", engines: { piarium: "*" } };
  }
  const source = parseSource(value.source, `${path}.source`, issues);
  const desired = parseDesired(value.desired, `${path}.desired`, issues);
  const capabilityGrants = parseGrants(value.capabilityGrants, `${path}.capabilityGrants`, issues);
  const installedAt = timestamp(value.installedAt, `${path}.installedAt`, issues);
  const updatedAt = timestamp(value.updatedAt, `${path}.updatedAt`, issues);
  const resolvedVersion = text(value.resolvedVersion) ?? "0.0.0";
  const selectedVersion = text(value.selectedVersion) ?? "0.0.0";
  if (!SEMVER_PATTERN.test(resolvedVersion)) issues.push(`${path}.resolvedVersion must be SemVer`);
  if (!SEMVER_PATTERN.test(selectedVersion)) issues.push(`${path}.selectedVersion must be SemVer`);
  if (resolvedVersion !== manifest.version) issues.push(`${path}.resolvedVersion must match manifest.version`);
  if (selectedVersion !== resolvedVersion) issues.push(`${path}.selectedVersion must match resolvedVersion until candidate updates are supported`);
  const selectedIntegrity = value.integrity === undefined
    ? undefined
    : integrity(value.integrity, `${path}.integrity`, issues);
  const resolvedPath = text(value.resolvedPath);
  const candidate = value.candidate === undefined
    ? undefined
    : parseCandidateRecord(value.candidate, `${path}.candidate`, issues);
  if (candidate && candidate.manifest.id !== manifest.id) {
    issues.push(`${path}.candidate.manifest.id must match selected manifest.id`);
  }
  throwIssues("Piarium extension installation", issues);
  return {
    manifest,
    source,
    desired,
    capabilityGrants,
    installedAt,
    updatedAt,
    resolvedVersion,
    selectedVersion,
    ...(selectedIntegrity ? { integrity: selectedIntegrity } : {}),
    ...(resolvedPath ? { resolvedPath } : {}),
    ...(candidate ? { candidate } : {}),
  };
}

export function parsePiariumExtensionCatalogDocument(value: unknown): PiariumExtensionCatalogDocument {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension catalog is invalid", ["catalog must be an object"]);
  if (value.schemaVersion !== PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION) issues.push("schemaVersion must be 1");
  const revision = positiveRevision(value.revision, "revision", issues, true);
  const updatedAt = timestamp(value.updatedAt, "updatedAt", issues);
  const extensions: Record<string, PiariumExtensionInstallationRecord> = {};
  if (!isRecord(value.extensions)) {
    issues.push("extensions must be an object");
  } else {
    for (const [key, raw] of Object.entries(value.extensions)) {
      const id = identifier(key, `extensions.${key}`, issues);
      try {
        const record = parsePiariumExtensionInstallationRecord(raw, `extensions.${key}`);
        if (record.manifest.id !== id) issues.push(`extensions.${key}.manifest.id must match its catalog key`);
        extensions[id] = record;
      } catch (error) {
        if (error instanceof PiariumExtensionContractError) issues.push(...error.issues);
        else throw error;
      }
    }
  }
  throwIssues("Piarium extension catalog", issues);
  return { schemaVersion: PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION, revision, updatedAt, extensions };
}

export function parsePiariumExtensionHostIdentityDocument(value: unknown): PiariumExtensionHostIdentityDocument {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension host identity is invalid", ["identity must be an object"]);
  if (value.schemaVersion !== PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION) issues.push("schemaVersion must be 1");
  const parsedHostId = hostId(value.hostId, "hostId", issues);
  const createdAt = timestamp(value.createdAt, "createdAt", issues);
  throwIssues("Piarium extension host identity", issues);
  return { schemaVersion: PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION, hostId: parsedHostId, createdAt };
}

function parseDiagnostic(value: unknown, path: string, issues: string[]): PiariumExtensionDiagnostic | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const code = text(value.code);
  const message = text(value.message);
  const severity = value.severity === "error" || value.severity === "info" || value.severity === "warning"
    ? value.severity
    : undefined;
  if (!code) issues.push(`${path}.code must be a non-empty string`);
  if (!message) issues.push(`${path}.message must be a non-empty string`);
  if (!severity) issues.push(`${path}.severity must be error, info, or warning`);
  const extensionId = value.extensionId === undefined
    ? undefined
    : identifier(value.extensionId, `${path}.extensionId`, issues);
  const realmId = value.realmId === undefined ? undefined : text(value.realmId);
  if (value.realmId !== undefined && !realmId) issues.push(`${path}.realmId must be a non-empty string`);
  return {
    code: code ?? "invalid",
    message: message ?? "Invalid diagnostic",
    severity: severity ?? "error",
    timestamp: timestamp(value.timestamp, `${path}.timestamp`, issues),
    ...(extensionId ? { extensionId } : {}),
    ...(realmId ? { realmId } : {}),
  };
}

function parseDiagnostics(value: unknown, path: string, issues: string[]): PiariumExtensionDiagnostic[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  return value.flatMap((item, index) => {
    const parsed = parseDiagnostic(item, `${path}[${index}]`, issues);
    return parsed ? [parsed] : [];
  });
}

function parseActualStates(value: unknown, path: string, issues: string[]): PiariumExtensionActualState[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  const states: PiariumExtensionActualState[] = [];
  const keys = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    const realmKind = raw.realmKind === "host" || raw.realmKind === "surface" ? raw.realmKind : undefined;
    if (!realmKind) issues.push(`${itemPath}.realmKind must be host or surface`);
    const realmId = text(raw.realmId);
    if (!realmId) issues.push(`${itemPath}.realmId must be a non-empty string`);
    const entrypointId = identifier(raw.entrypointId, `${itemPath}.entrypointId`, issues);
    const status = text(raw.status);
    if (!status || !ACTUAL_STATUSES.has(status as PiariumExtensionActualStatus)) issues.push(`${itemPath}.status is unsupported`);
    const key = `${realmKind ?? "invalid"}:${realmId ?? "invalid"}:${entrypointId}`;
    if (keys.has(key)) issues.push(`${path} contains duplicate actual state ${key}`);
    keys.add(key);
    states.push({
      hostId: hostId(raw.hostId, `${itemPath}.hostId`, issues),
      realmKind: realmKind ?? "surface",
      realmId: realmId ?? "invalid",
      entrypointId,
      status: ACTUAL_STATUSES.has(status as PiariumExtensionActualStatus) ? status as PiariumExtensionActualStatus : "failed",
      generation: positiveRevision(raw.generation, `${itemPath}.generation`, issues, true),
      desiredRevision: positiveRevision(raw.desiredRevision, `${itemPath}.desiredRevision`, issues),
      updatedAt: timestamp(raw.updatedAt, `${itemPath}.updatedAt`, issues),
      diagnostics: parseDiagnostics(raw.diagnostics, `${itemPath}.diagnostics`, issues),
    });
  });
  return states;
}

function parsePublicCatalogEntry(value: unknown, path: string, issues: string[]): PiariumExtensionCatalogEntry | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  let manifest: PiariumExtensionManifest;
  try {
    manifest = parsePiariumExtensionManifest(value.manifest);
  } catch (error) {
    if (error instanceof PiariumExtensionContractError) issues.push(...error.issues.map((issue) => `${path}.manifest.${issue}`));
    manifest = { schemaVersion: 1, id: "invalid", version: "0.0.0", engines: { piarium: "*" } };
  }
  const source = isRecord(value.source) ? value.source : {};
  if (!isRecord(value.source)) issues.push(`${path}.source must be an object`);
  const sourceKind = text(source.kind);
  if (!sourceKind || !SOURCE_KINDS.has(sourceKind)) issues.push(`${path}.source.kind is unsupported`);
  const sourceDisplay = text(source.display);
  if (!sourceDisplay) issues.push(`${path}.source.display must be a non-empty string`);
  const resolvedVersion = text(value.resolvedVersion) ?? "0.0.0";
  const selectedVersion = text(value.selectedVersion) ?? "0.0.0";
  if (!SEMVER_PATTERN.test(resolvedVersion)) issues.push(`${path}.resolvedVersion must be SemVer`);
  if (!SEMVER_PATTERN.test(selectedVersion)) issues.push(`${path}.selectedVersion must be SemVer`);
  if (resolvedVersion !== manifest.version) issues.push(`${path}.resolvedVersion must match manifest.version`);
  if (selectedVersion !== resolvedVersion) issues.push(`${path}.selectedVersion must match resolvedVersion`);
  const selectedIntegrity = value.integrity === undefined
    ? undefined
    : integrity(value.integrity, `${path}.integrity`, issues);
  let candidate: PiariumExtensionCatalogEntry["candidate"];
  if (value.candidate !== undefined) {
    if (!isRecord(value.candidate)) {
      issues.push(`${path}.candidate must be an object`);
    } else {
      let candidateManifest: PiariumExtensionManifest;
      try {
        candidateManifest = parsePiariumExtensionManifest(value.candidate.manifest);
      } catch (error) {
        if (error instanceof PiariumExtensionContractError) {
          issues.push(...error.issues.map((issue) => `${path}.candidate.manifest.${issue}`));
        }
        candidateManifest = { schemaVersion: 1, id: "invalid", version: "0.0.0", engines: { piarium: "*" } };
      }
      const candidateSource = isRecord(value.candidate.source) ? value.candidate.source : {};
      if (!isRecord(value.candidate.source)) issues.push(`${path}.candidate.source must be an object`);
      const candidateKind = text(candidateSource.kind);
      const candidateDisplay = text(candidateSource.display);
      if (!candidateKind || !SOURCE_KINDS.has(candidateKind)) issues.push(`${path}.candidate.source.kind is unsupported`);
      if (!candidateDisplay) issues.push(`${path}.candidate.source.display must be a non-empty string`);
      const candidateVersion = text(value.candidate.resolvedVersion) ?? "0.0.0";
      if (!SEMVER_PATTERN.test(candidateVersion)) issues.push(`${path}.candidate.resolvedVersion must be SemVer`);
      if (candidateVersion !== candidateManifest.version) issues.push(`${path}.candidate.resolvedVersion must match candidate manifest.version`);
      if (candidateManifest.id !== manifest.id) issues.push(`${path}.candidate.manifest.id must match selected manifest.id`);
      candidate = {
        integrity: integrity(value.candidate.integrity, `${path}.candidate.integrity`, issues),
        manifest: candidateManifest,
        preparedAt: timestamp(value.candidate.preparedAt, `${path}.candidate.preparedAt`, issues),
        resolvedVersion: candidateVersion,
        source: {
          kind: SOURCE_KINDS.has(candidateKind ?? "")
            ? candidateKind as PiariumExtensionCatalogEntry["source"]["kind"]
            : "local",
          display: candidateDisplay ?? "Invalid source",
        },
      };
    }
  }
  return {
    manifest,
    source: {
      kind: SOURCE_KINDS.has(sourceKind ?? "") ? sourceKind as PiariumExtensionCatalogEntry["source"]["kind"] : "local",
      display: sourceDisplay ?? "Invalid source",
    },
    resolvedVersion,
    selectedVersion,
    desired: parseDesired(value.desired, `${path}.desired`, issues),
    actual: parseActualStates(value.actual, `${path}.actual`, issues),
    capabilityGrants: parseGrants(value.capabilityGrants, `${path}.capabilityGrants`, issues),
    installedAt: timestamp(value.installedAt, `${path}.installedAt`, issues),
    updatedAt: timestamp(value.updatedAt, `${path}.updatedAt`, issues),
    ...(selectedIntegrity ? { integrity: selectedIntegrity } : {}),
    ...(candidate ? { candidate } : {}),
  };
}

export function parsePiariumExtensionCatalogSnapshot(value: unknown): PiariumExtensionCatalogSnapshot {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension catalog snapshot is invalid", ["snapshot must be an object"]);
  if (value.schemaVersion !== PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION) issues.push("schemaVersion must be 1");
  const storageState = text(value.storageState);
  if (!storageState || !STORAGE_STATES.has(storageState)) issues.push("storageState is unsupported");
  if (typeof value.authoritative !== "boolean") issues.push("authoritative must be boolean");
  if (storageState === "stale" && value.authoritative !== false) issues.push("a stale snapshot cannot be authoritative");
  const extensions: PiariumExtensionCatalogEntry[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(value.extensions)) {
    issues.push("extensions must be an array");
  } else {
    value.extensions.forEach((raw, index) => {
      const entry = parsePublicCatalogEntry(raw, `extensions[${index}]`, issues);
      if (!entry) return;
      if (ids.has(entry.manifest.id)) issues.push(`extensions contains duplicate extension ${entry.manifest.id}`);
      ids.add(entry.manifest.id);
      extensions.push(entry);
    });
  }
  const parsedHostId = hostId(value.hostId, "hostId", issues);
  const revision = positiveRevision(value.revision, "revision", issues, true);
  const loadedAt = timestamp(value.loadedAt, "loadedAt", issues);
  const diagnostics = parseDiagnostics(value.diagnostics, "diagnostics", issues);
  for (const entry of extensions) {
    for (const actual of entry.actual) {
      if (actual.hostId !== parsedHostId) issues.push(`actual state for ${entry.manifest.id} belongs to another host`);
      if (actual.desiredRevision !== entry.desired.revision) issues.push(`actual state for ${entry.manifest.id} has a stale desired revision`);
    }
  }
  throwIssues("Piarium extension catalog snapshot", issues);
  return {
    schemaVersion: PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION,
    hostId: parsedHostId,
    revision,
    loadedAt,
    authoritative: value.authoritative === true,
    storageState: storageState as PiariumExtensionCatalogSnapshot["storageState"],
    diagnostics,
    extensions,
  };
}

export function parsePiariumExtensionCatalogAvailability(value: unknown): PiariumExtensionCatalogAvailability {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension catalog response is invalid", ["response must be an object"]);
  if (value.supported === false) {
    const reason = text(value.reason);
    if (!reason) issues.push("reason must be a non-empty string");
    throwIssues("Piarium extension catalog response", issues);
    return { supported: false, reason: reason as string };
  }
  if (value.supported !== true) issues.push("supported must be boolean");
  if (value.status === "ready") {
    let snapshot: PiariumExtensionCatalogSnapshot | undefined;
    try {
      snapshot = parsePiariumExtensionCatalogSnapshot(value.snapshot);
    } catch (error) {
      if (error instanceof PiariumExtensionContractError) issues.push(...error.issues.map((issue) => `snapshot.${issue}`));
      else throw error;
    }
    throwIssues("Piarium extension catalog response", issues);
    return { supported: true, status: "ready", snapshot: snapshot as PiariumExtensionCatalogSnapshot };
  }
  if (value.status === "error") {
    if (!isRecord(value.error)) issues.push("error must be an object");
    const rawError = isRecord(value.error) ? value.error : {};
    const code = text(rawError.code);
    const message = text(rawError.message);
    if (!code) issues.push("error.code must be a non-empty string");
    if (!message) issues.push("error.message must be a non-empty string");
    if (typeof rawError.retryable !== "boolean") issues.push("error.retryable must be boolean");
    throwIssues("Piarium extension catalog response", issues);
    return {
      supported: true,
      status: "error",
      error: { code: code as string, message: message as string, retryable: rawError.retryable === true },
    };
  }
  issues.push("status must be ready or error");
  throwIssues("Piarium extension catalog response", issues);
  throw new Error("unreachable");
}

export function isPiariumExtensionId(value: string): boolean {
  return ID_PATTERN.test(value);
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseArtifactSlot(value: unknown, path: string, issues: string[]): "candidate" | "selected" {
  if (value !== "candidate" && value !== "selected") {
    issues.push(`${path} must be candidate or selected`);
    return "selected";
  }
  return value;
}

export function parsePiariumExtensionAssetRequest(value: unknown): PiariumExtensionAssetRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension asset request is invalid", ["request must be an object"]);
  const result: PiariumExtensionAssetRequest = {
    extensionId: identifier(value.extensionId, "extensionId", issues),
    integrity: integrity(value.integrity, "integrity", issues),
    path: entryPath(value.path, "path", issues),
    slot: parseArtifactSlot(value.slot, "slot", issues),
  };
  throwIssues("Piarium extension asset request", issues);
  return result;
}

export function parsePiariumExtensionManagedEntrypointRequest(value: unknown): PiariumExtensionManagedEntrypointRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension entrypoint request is invalid", ["request must be an object"]);
  const result: PiariumExtensionManagedEntrypointRequest = {
    entrypointId: identifier(value.entrypointId, "entrypointId", issues),
    extensionId: identifier(value.extensionId, "extensionId", issues),
    integrity: integrity(value.integrity, "integrity", issues),
    slot: parseArtifactSlot(value.slot, "slot", issues),
  };
  throwIssues("Piarium extension entrypoint request", issues);
  return result;
}

function parseAssetPayload(value: unknown, path: string, issues: string[]): PiariumExtensionAssetPayload {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return {
      artifactIntegrity: `sha256-${"0".repeat(64)}`,
      bytesBase64: "",
      contentType: "application/octet-stream",
      integrity: `sha256-${"0".repeat(64)}`,
      path: "invalid",
    };
  }
  const bytesBase64 = typeof value.bytesBase64 === "string" ? value.bytesBase64 : "";
  if (typeof value.bytesBase64 !== "string" || !BASE64_PATTERN.test(bytesBase64)) {
    issues.push(`${path}.bytesBase64 must be base64 data`);
  }
  const contentType = text(value.contentType);
  if (!contentType) issues.push(`${path}.contentType must be a non-empty string`);
  return {
    artifactIntegrity: integrity(value.artifactIntegrity, `${path}.artifactIntegrity`, issues),
    bytesBase64,
    contentType: contentType ?? "application/octet-stream",
    integrity: integrity(value.integrity, `${path}.integrity`, issues),
    path: entryPath(value.path, `${path}.path`, issues),
  };
}

export function parsePiariumExtensionAssetPayload(value: unknown): PiariumExtensionAssetPayload {
  const issues: string[] = [];
  const result = parseAssetPayload(value, "asset", issues);
  throwIssues("Piarium extension asset payload", issues);
  return result;
}

export function parsePiariumExtensionManagedEntrypointPayload(value: unknown): PiariumExtensionManagedEntrypointPayload {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension entrypoint payload is invalid", ["payload must be an object"]);
  const styles = Array.isArray(value.styles)
    ? value.styles.map((style, index) => parseAssetPayload(style, `styles[${index}]`, issues))
    : (issues.push("styles must be an array"), []);
  const result: PiariumExtensionManagedEntrypointPayload = {
    artifactIntegrity: integrity(value.artifactIntegrity, "artifactIntegrity", issues),
    entrypointId: identifier(value.entrypointId, "entrypointId", issues),
    module: parseAssetPayload(value.module, "module", issues),
    styles,
  };
  if (result.module.artifactIntegrity !== result.artifactIntegrity || styles.some((style) => style.artifactIntegrity !== result.artifactIntegrity)) {
    issues.push("entrypoint assets must belong to the declared artifact integrity");
  }
  throwIssues("Piarium extension entrypoint payload", issues);
  return result;
}

export function parsePiariumExtensionCandidateSelectionRequest(value: unknown): PiariumExtensionCandidateSelectionRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension candidate selection request is invalid", ["request must be an object"]);
  const result: PiariumExtensionCandidateSelectionRequest = {
    candidateIntegrity: integrity(value.candidateIntegrity, "candidateIntegrity", issues),
    expectedRevision: positiveRevision(value.expectedRevision, "expectedRevision", issues, true),
    extensionId: identifier(value.extensionId, "extensionId", issues),
  };
  throwIssues("Piarium extension candidate selection request", issues);
  return result;
}

export function parsePiariumExtensionPackageSource(value: unknown): PiariumExtensionPackageSource {
  const issues: string[] = [];
  const result = parseSource(value, "source", issues);
  throwIssues("Piarium extension package source", issues);
  return result;
}

export function parsePiariumExtensionPackageInstallRequest(value: unknown): PiariumExtensionPackageInstallRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension install request is invalid", ["request must be an object"]);
  const result = {
    expectedRevision: positiveRevision(value.expectedRevision, "expectedRevision", issues, true),
    source: parseSource(value.source, "source", issues),
  };
  throwIssues("Piarium extension install request", issues);
  return result;
}

export function parsePiariumExtensionActualState(value: unknown): PiariumExtensionActualState {
  const issues: string[] = [];
  const states = parseActualStates([value], "actual", issues);
  throwIssues("Piarium extension actual state", issues);
  return states[0] as PiariumExtensionActualState;
}

function parseServiceProvider(value: unknown, path: string, issues: string[]): PiariumExtensionServiceProviderSnapshot | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const descriptor = parseServices<PiariumExtensionServiceProvision>([value.descriptor], `${path}.descriptor`, issues, "provide")?.[0];
  const status = value.status === "active" || value.status === "candidate" || value.status === "draining" ? value.status : undefined;
  if (!status) issues.push(`${path}.status must be active, candidate, or draining`);
  const providerId = text(value.providerId);
  if (!providerId) issues.push(`${path}.providerId must be a non-empty string`);
  const extensionVersion = text(value.extensionVersion) ?? "0.0.0";
  if (!SEMVER_PATTERN.test(extensionVersion)) issues.push(`${path}.extensionVersion must be SemVer`);
  if (!descriptor) return undefined;
  return {
    descriptor,
    entrypointId: identifier(value.entrypointId, `${path}.entrypointId`, issues),
    extensionId: identifier(value.extensionId, `${path}.extensionId`, issues),
    extensionVersion,
    generation: positiveRevision(value.generation, `${path}.generation`, issues, true),
    providerId: providerId ?? "invalid",
    status: status ?? "draining",
  };
}

export function parsePiariumExtensionCandidatePreparationResult(value: unknown): PiariumExtensionCandidatePreparationResult {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension candidate preparation is invalid", ["result must be an object"]);
  const providers = Array.isArray(value.providers)
    ? value.providers.flatMap((provider, index) => {
      const parsed = parseServiceProvider(provider, `providers[${index}]`, issues);
      if (parsed && parsed.status !== "candidate") issues.push(`providers[${index}].status must be candidate`);
      return parsed ? [parsed] : [];
    })
    : (issues.push("providers must be an array"), []);
  const integrity = text(value.integrity);
  if (!integrity) issues.push("integrity must be a non-empty string");
  const result: PiariumExtensionCandidatePreparationResult = {
    extensionId: identifier(value.extensionId, "extensionId", issues),
    integrity: integrity ?? "invalid",
    providers,
  };
  throwIssues("Piarium extension candidate preparation", issues);
  return result;
}

export function parsePiariumExtensionServiceCatalogSnapshot(value: unknown): PiariumExtensionServiceCatalogSnapshot {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension service catalog is invalid", ["catalog must be an object"]);
  const providers = Array.isArray(value.providers)
    ? value.providers.flatMap((provider, index) => {
      const parsed = parseServiceProvider(provider, `providers[${index}]`, issues);
      return parsed ? [parsed] : [];
    })
    : (issues.push("providers must be an array"), []);
  const providerIds = new Set<string>();
  for (const provider of providers) {
    if (providerIds.has(provider.providerId)) issues.push(`providers contains duplicate provider ${provider.providerId}`);
    providerIds.add(provider.providerId);
  }
  const selections: Record<string, string> = {};
  if (!isRecord(value.selections)) issues.push("selections must be an object");
  else {
    for (const [service, provider] of Object.entries(value.selections)) {
      const selected = text(provider);
      if (!selected) issues.push(`selections.${service} must be a non-empty provider ID`);
      else selections[service] = selected;
    }
  }
  const result = {
    hostId: hostId(value.hostId, "hostId", issues),
    providers,
    revision: positiveRevision(value.revision, "revision", issues, true),
    selections,
  };
  throwIssues("Piarium extension service catalog", issues);
  return result;
}

export function parsePiariumExtensionServiceInvocationRequest(value: unknown): PiariumExtensionServiceInvocationRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension service invocation is invalid", ["request must be an object"]);
  const method = text(value.method);
  if (!method) issues.push("method must be a non-empty string");
  const args = Array.isArray(value.args)
    ? value.args.map((arg, index) => jsonValue(arg, `args[${index}]`, issues))
    : (issues.push("args must be an array"), []);
  const providerId = value.providerId === undefined ? undefined : text(value.providerId);
  if (value.providerId !== undefined && !providerId) issues.push("providerId must be a non-empty string");
  const result: PiariumExtensionServiceInvocationRequest = {
    args,
    method: method ?? "invalid",
    serviceId: identifier(value.serviceId, "serviceId", issues),
    version: positiveRevision(value.version, "version", issues),
    ...(providerId ? { providerId } : {}),
  };
  throwIssues("Piarium extension service invocation", issues);
  return result;
}

export function parsePiariumExtensionServiceSelectionRequest(value: unknown): PiariumExtensionServiceSelectionRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension service selection is invalid", ["request must be an object"]);
  const providerId = value.providerId === null ? null : text(value.providerId);
  if (value.providerId !== null && !providerId) issues.push("providerId must be a non-empty string or null");
  const result: PiariumExtensionServiceSelectionRequest = {
    providerId: providerId ?? null,
    serviceId: identifier(value.serviceId, "serviceId", issues),
    version: positiveRevision(value.version, "version", issues),
  };
  throwIssues("Piarium extension service selection", issues);
  return result;
}

export function parsePiariumExtensionHostStateWaitRequest(value: unknown): PiariumExtensionHostStateWaitRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension host-state wait request is invalid", ["request must be an object"]);
  const result = {
    hostId: hostId(value.hostId, "hostId", issues),
    revision: positiveRevision(value.revision, "revision", issues, true),
  };
  throwIssues("Piarium extension host-state wait request", issues);
  return result;
}

export function parsePiariumExtensionHostStateSnapshot(value: unknown): PiariumExtensionHostStateSnapshot {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension host-state snapshot is invalid", ["snapshot must be an object"]);
  let catalog: PiariumExtensionCatalogSnapshot | undefined;
  let services: PiariumExtensionServiceCatalogSnapshot | undefined;
  try { catalog = parsePiariumExtensionCatalogSnapshot(value.catalog); }
  catch (error) { if (error instanceof PiariumExtensionContractError) issues.push(...error.issues.map((issue) => `catalog.${issue}`)); else throw error; }
  try { services = parsePiariumExtensionServiceCatalogSnapshot(value.services); }
  catch (error) { if (error instanceof PiariumExtensionContractError) issues.push(...error.issues.map((issue) => `services.${issue}`)); else throw error; }
  if (catalog && services && catalog.hostId !== services.hostId) issues.push("catalog and services must belong to the same application host");
  const revision = positiveRevision(value.revision, "revision", issues, true);
  throwIssues("Piarium extension host-state snapshot", issues);
  return { catalog: catalog as PiariumExtensionCatalogSnapshot, revision, services: services as PiariumExtensionServiceCatalogSnapshot };
}

const STORAGE_SCOPES = new Set(["application", "profile", "session", "surface", "workspace"]);

export function parsePiariumExtensionStorageAddress(value: unknown): PiariumExtensionStorageAddress {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension storage address is invalid", ["address must be an object"]);
  const key = text(value.key);
  if (!key) issues.push("key must be a non-empty string");
  const scope = text(value.scope);
  if (!scope || !STORAGE_SCOPES.has(scope)) issues.push("scope is unsupported");
  const result: PiariumExtensionStorageAddress = {
    extensionId: identifier(value.extensionId, "extensionId", issues),
    key: key ?? "invalid",
    scope: STORAGE_SCOPES.has(scope ?? "") ? scope as PiariumExtensionStorageAddress["scope"] : "application",
  };
  throwIssues("Piarium extension storage address", issues);
  return result;
}

function parseStorageDocument(value: unknown, path: string, issues: string[]): PiariumExtensionStorageDocument {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return { data: {}, revision: 0, schemaVersion: 0, updatedAt: new Date(0).toISOString() };
  }
  const data = isRecord(value.data) ? jsonValue(value.data, `${path}.data`, issues) as JsonObject : {};
  if (!isRecord(value.data)) issues.push(`${path}.data must be an object`);
  return {
    data,
    revision: positiveRevision(value.revision, `${path}.revision`, issues, true),
    schemaVersion: positiveRevision(value.schemaVersion, `${path}.schemaVersion`, issues, true),
    updatedAt: timestamp(value.updatedAt, `${path}.updatedAt`, issues),
  };
}

export function parsePiariumExtensionStorageSnapshot(value: unknown): PiariumExtensionStorageSnapshot {
  const issues: string[] = [];
  if (!isRecord(value)) throw new PiariumExtensionContractError("Piarium extension storage snapshot is invalid", ["snapshot must be an object"]);
  const storageState = value.storageState === "missing" || value.storageState === "ready" || value.storageState === "stale"
    ? value.storageState
    : undefined;
  if (!storageState) issues.push("storageState is unsupported");
  if (typeof value.authoritative !== "boolean") issues.push("authoritative must be boolean");
  if (typeof value.exists !== "boolean") issues.push("exists must be boolean");
  if (storageState === "stale" && value.authoritative !== false) issues.push("stale storage cannot be authoritative");
  const result: PiariumExtensionStorageSnapshot = {
    address: (() => {
      try { return parsePiariumExtensionStorageAddress(value.address); }
      catch (error) {
        if (error instanceof PiariumExtensionContractError) issues.push(...error.issues.map((issue) => `address.${issue}`));
        return { extensionId: "invalid", key: "invalid", scope: "application" };
      }
    })(),
    authoritative: value.authoritative === true,
    diagnostics: parseDiagnostics(value.diagnostics, "diagnostics", issues),
    document: parseStorageDocument(value.document, "document", issues),
    exists: value.exists === true,
    storageState: storageState ?? "stale",
  };
  throwIssues("Piarium extension storage snapshot", issues);
  return result;
}
