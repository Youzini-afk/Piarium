import type {
  PiariumApplicationSurface,
  PiariumExtensionDiagnostic,
  PiariumExtensionStorageSnapshot,
} from "./types.js";

export const PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION = 1 as const;

export type PiariumWorkbenchLayoutScope = "distribution" | "user" | "workspace";

export interface PiariumWorkbenchLayoutReference {
  contributionId: string;
  order?: number;
  region?: string;
  size?: number;
  visible?: boolean;
}

export interface PiariumWorkbenchLayoutLayer {
  profileId: string;
  references: PiariumWorkbenchLayoutReference[];
  replacementSelections: Record<string, string>;
  scope: PiariumWorkbenchLayoutScope;
  scopeId: string;
  surface: PiariumApplicationSurface;
}

export interface PiariumWorkbenchDistributionProfile {
  extensionIds?: string[];
  id: string;
  label: string;
}

export interface PiariumWorkbenchProfileSelections {
  users: Record<string, string>;
  workspaces: Record<string, string>;
}

export interface PiariumWorkbenchProfileDocument {
  activeProfileId: string;
  layouts: PiariumWorkbenchLayoutLayer[];
  profileSelections: PiariumWorkbenchProfileSelections;
  profiles: PiariumWorkbenchDistributionProfile[];
  revision: number;
  schemaVersion: typeof PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION;
  updatedAt: string;
}

export interface PiariumWorkbenchProfileSnapshot {
  authoritative: boolean;
  diagnostics: PiariumExtensionDiagnostic[];
  document: PiariumWorkbenchProfileDocument;
  hostId: string;
  storageState: "missing" | "ready" | "stale";
}

export interface PiariumWorkbenchLayoutUpdateRequest {
  expectedRevision: number;
  layer: PiariumWorkbenchLayoutLayer;
}

export interface PiariumWorkbenchProfileSelectionRequest {
  expectedRevision: number;
  profileId: string;
  scope: "application" | "user" | "workspace";
  scopeId?: string;
}

export interface PiariumWorkbenchProfileUpsertRequest {
  expectedRevision: number;
  profile: PiariumWorkbenchDistributionProfile;
}

export interface PiariumWorkbenchProfileRemoveRequest {
  expectedRevision: number;
  profileId: string;
}

export interface PiariumWorkbenchResolutionContext {
  surface: PiariumApplicationSurface;
  userId: string;
  workspaceId?: string;
}

export interface PiariumWorkbenchResolvedLayout {
  profileId: string;
  references: PiariumWorkbenchLayoutReference[];
  replacementSelections: Record<string, string>;
}

const SURFACES = new Set<PiariumApplicationSurface>(["desktop", "mobile", "vscode", "web"]);
const SCOPES = new Set<PiariumWorkbenchLayoutScope>(["distribution", "user", "workspace"]);
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const record = (value: unknown): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
};

const revision = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return Number(value);
};

const profileId = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (!ID_PATTERN.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
};

const contributionId = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (!ID_PATTERN.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
};

const parseProfile = (value: unknown, label: string): PiariumWorkbenchDistributionProfile => {
  const raw = record(value);
  if (!raw) throw new Error(`${label} must be an object`);
  let extensionIds: string[] | undefined;
  if (raw.extensionIds !== undefined) {
    if (!Array.isArray(raw.extensionIds)) throw new Error(`${label}.extensionIds must be an array`);
    extensionIds = raw.extensionIds.map((id, index) => contributionId(id, `${label}.extensionIds[${index}]`));
    if (new Set(extensionIds).size !== extensionIds.length) throw new Error(`${label}.extensionIds contains duplicates`);
  }
  return {
    id: profileId(raw.id, `${label}.id`),
    label: text(raw.label, `${label}.label`),
    ...(extensionIds ? { extensionIds } : {}),
  };
};

const parseReference = (value: unknown, label: string): PiariumWorkbenchLayoutReference => {
  const raw = record(value);
  if (!raw) throw new Error(`${label} must be an object`);
  const result: PiariumWorkbenchLayoutReference = {
    contributionId: contributionId(raw.contributionId, `${label}.contributionId`),
  };
  if (raw.order !== undefined) {
    if (typeof raw.order !== "number" || !Number.isFinite(raw.order)) throw new Error(`${label}.order must be finite`);
    result.order = raw.order;
  }
  if (raw.region !== undefined) result.region = text(raw.region, `${label}.region`);
  if (raw.size !== undefined) {
    if (typeof raw.size !== "number" || !Number.isFinite(raw.size) || raw.size <= 0) throw new Error(`${label}.size must be positive`);
    result.size = raw.size;
  }
  if (raw.visible !== undefined) {
    if (typeof raw.visible !== "boolean") throw new Error(`${label}.visible must be boolean`);
    result.visible = raw.visible;
  }
  return result;
};

export const parsePiariumWorkbenchLayoutLayer = (value: unknown): PiariumWorkbenchLayoutLayer => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench layout layer must be an object");
  const surface = text(raw.surface, "layer.surface") as PiariumApplicationSurface;
  if (!SURFACES.has(surface)) throw new Error("layer.surface is unsupported");
  const scope = text(raw.scope, "layer.scope") as PiariumWorkbenchLayoutScope;
  if (!SCOPES.has(scope)) throw new Error("layer.scope is unsupported");
  if (!Array.isArray(raw.references)) throw new Error("layer.references must be an array");
  const references = raw.references.map((item, index) => parseReference(item, `layer.references[${index}]`));
  if (new Set(references.map((item) => item.contributionId)).size !== references.length) {
    throw new Error("layer.references contains duplicate contribution IDs");
  }
  const rawSelections = record(raw.replacementSelections);
  if (!rawSelections) throw new Error("layer.replacementSelections must be an object");
  const replacementSelections: Record<string, string> = {};
  for (const [target, selected] of Object.entries(rawSelections)) {
    replacementSelections[contributionId(target, `layer.replacementSelections.${target}`)] = contributionId(
      selected,
      `layer.replacementSelections.${target}`,
    );
  }
  return {
    profileId: profileId(raw.profileId, "layer.profileId"),
    references,
    replacementSelections,
    scope,
    scopeId: text(raw.scopeId, "layer.scopeId"),
    surface,
  };
};

const parseStringMap = (value: unknown, label: string): Record<string, string> => {
  const raw = record(value);
  if (!raw) throw new Error(`${label} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, selected] of Object.entries(raw)) {
    if (!key.trim()) throw new Error(`${label} contains an empty scope ID`);
    result[key] = profileId(selected, `${label}.${key}`);
  }
  return result;
};

export const parsePiariumWorkbenchProfileDocument = (value: unknown): PiariumWorkbenchProfileDocument => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench profile document must be an object");
  if (raw.schemaVersion !== PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION) throw new Error("Workbench profile schemaVersion is unsupported");
  if (!Array.isArray(raw.profiles) || raw.profiles.length === 0) throw new Error("Workbench profiles must contain at least one profile");
  const profiles = raw.profiles.map((item, index) => parseProfile(item, `profiles[${index}]`));
  if (new Set(profiles.map((item) => item.id)).size !== profiles.length) throw new Error("Workbench profile IDs must be unique");
  if (!Array.isArray(raw.layouts)) throw new Error("Workbench layouts must be an array");
  const layouts = raw.layouts.map(parsePiariumWorkbenchLayoutLayer);
  const layoutKeys = layouts.map((layer) => `${layer.profileId}\0${layer.surface}\0${layer.scope}\0${layer.scopeId}`);
  if (new Set(layoutKeys).size !== layoutKeys.length) throw new Error("Workbench layout layer identities must be unique");
  const selections = record(raw.profileSelections);
  if (!selections) throw new Error("Workbench profileSelections must be an object");
  const activeProfileId = profileId(raw.activeProfileId, "activeProfileId");
  const knownProfiles = new Set(profiles.map((item) => item.id));
  const profileSelections = {
    users: parseStringMap(selections.users, "profileSelections.users"),
    workspaces: parseStringMap(selections.workspaces, "profileSelections.workspaces"),
  };
  if (!knownProfiles.has(activeProfileId)) throw new Error("activeProfileId does not name an installed profile");
  for (const selected of [...Object.values(profileSelections.users), ...Object.values(profileSelections.workspaces)]) {
    if (!knownProfiles.has(selected)) throw new Error(`Profile selection names an unknown profile: ${selected}`);
  }
  for (const layer of layouts) {
    if (!knownProfiles.has(layer.profileId)) throw new Error(`Layout names an unknown profile: ${layer.profileId}`);
  }
  const updatedAt = text(raw.updatedAt, "updatedAt");
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error("updatedAt must be an ISO timestamp");
  return {
    activeProfileId,
    layouts,
    profileSelections,
    profiles,
    revision: revision(raw.revision, "revision"),
    schemaVersion: PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION,
    updatedAt,
  };
};

export const parsePiariumWorkbenchProfileSnapshot = (value: unknown): PiariumWorkbenchProfileSnapshot => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench profile snapshot must be an object");
  const storageState = raw.storageState;
  if (storageState !== "missing" && storageState !== "ready" && storageState !== "stale") {
    throw new Error("Workbench profile storageState is unsupported");
  }
  if (typeof raw.authoritative !== "boolean") throw new Error("Workbench profile authoritative must be boolean");
  if (!Array.isArray(raw.diagnostics)) throw new Error("Workbench profile diagnostics must be an array");
  return {
    authoritative: raw.authoritative,
    diagnostics: raw.diagnostics as PiariumExtensionDiagnostic[],
    document: parsePiariumWorkbenchProfileDocument(raw.document),
    hostId: text(raw.hostId, "hostId"),
    storageState,
  };
};

export const parsePiariumWorkbenchLayoutUpdateRequest = (value: unknown): PiariumWorkbenchLayoutUpdateRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench layout update request must be an object");
  return {
    expectedRevision: revision(raw.expectedRevision, "expectedRevision"),
    layer: parsePiariumWorkbenchLayoutLayer(raw.layer),
  };
};

export const parsePiariumWorkbenchProfileSelectionRequest = (value: unknown): PiariumWorkbenchProfileSelectionRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench profile selection request must be an object");
  const scope = raw.scope;
  if (scope !== "application" && scope !== "user" && scope !== "workspace") throw new Error("Profile selection scope is unsupported");
  const scopeId = raw.scopeId === undefined ? undefined : text(raw.scopeId, "scopeId");
  if (scope === "application" && scopeId !== undefined) throw new Error("Application profile selection cannot include scopeId");
  if (scope !== "application" && scopeId === undefined) throw new Error(`${scope} profile selection requires scopeId`);
  return {
    expectedRevision: revision(raw.expectedRevision, "expectedRevision"),
    profileId: profileId(raw.profileId, "profileId"),
    scope,
    ...(scopeId ? { scopeId } : {}),
  };
};

export const parsePiariumWorkbenchProfileUpsertRequest = (value: unknown): PiariumWorkbenchProfileUpsertRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench profile upsert request must be an object");
  return { expectedRevision: revision(raw.expectedRevision, "expectedRevision"), profile: parseProfile(raw.profile, "profile") };
};

export const parsePiariumWorkbenchProfileRemoveRequest = (value: unknown): PiariumWorkbenchProfileRemoveRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench profile remove request must be an object");
  return { expectedRevision: revision(raw.expectedRevision, "expectedRevision"), profileId: profileId(raw.profileId, "profileId") };
};

export const defaultPiariumWorkbenchProfileDocument = (): PiariumWorkbenchProfileDocument => ({
  activeProfileId: "default",
  layouts: [],
  profileSelections: { users: {}, workspaces: {} },
  profiles: [{ id: "default", label: "Default" }],
  revision: 0,
  schemaVersion: PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
});

export const resolvePiariumWorkbenchLayout = (
  documentValue: PiariumWorkbenchProfileDocument | unknown,
  context: PiariumWorkbenchResolutionContext,
): PiariumWorkbenchResolvedLayout => {
  const document = parsePiariumWorkbenchProfileDocument(documentValue);
  if (!SURFACES.has(context.surface)) throw new Error("Workbench resolution surface is unsupported");
  const userId = text(context.userId, "userId");
  const workspaceId = context.workspaceId?.trim() || undefined;
  const profileIdValue = (workspaceId ? document.profileSelections.workspaces[workspaceId] : undefined)
    ?? document.profileSelections.users[userId]
    ?? document.activeProfileId;
  const layers = document.layouts.filter((layer) => (
    layer.profileId === profileIdValue
    && layer.surface === context.surface
    && (
      (layer.scope === "distribution" && layer.scopeId === profileIdValue)
      || (layer.scope === "user" && layer.scopeId === userId)
      || (layer.scope === "workspace" && workspaceId !== undefined && layer.scopeId === workspaceId)
    )
  )).sort((left, right) => (
    ["distribution", "user", "workspace"].indexOf(left.scope)
    - ["distribution", "user", "workspace"].indexOf(right.scope)
  ));
  const references = new Map<string, PiariumWorkbenchLayoutReference>();
  const replacementSelections: Record<string, string> = {};
  for (const layer of layers) {
    for (const reference of layer.references) {
      references.set(reference.contributionId, {
        ...(references.get(reference.contributionId) ?? {}),
        ...reference,
      });
    }
    Object.assign(replacementSelections, layer.replacementSelections);
  }
  return { profileId: profileIdValue, references: [...references.values()], replacementSelections };
};

export const workbenchDocumentFromStorage = (
  snapshot: PiariumExtensionStorageSnapshot,
): PiariumWorkbenchProfileDocument => parsePiariumWorkbenchProfileDocument({
  ...(snapshot.exists ? snapshot.document.data : defaultPiariumWorkbenchProfileDocument()),
  revision: snapshot.document.revision,
  schemaVersion: PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION,
  updatedAt: snapshot.document.updatedAt,
});
