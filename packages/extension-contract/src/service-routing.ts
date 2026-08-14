import type {
  PiariumExtensionDiagnostic,
  PiariumExtensionStorageSnapshot,
} from "./types.js";

export const PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION = 1 as const;

export interface PiariumExtensionServiceRoutingContext {
  agentId?: string;
  distributionId?: string;
  invocationId?: string;
  modelId?: string;
  modelProviderId?: string;
  profileId?: string;
  projectId?: string;
  runtimeId?: string;
  sessionId?: string;
  userId?: string;
  workspaceId?: string;
}

export interface PiariumExtensionServiceRoutingRule {
  allowFallback: boolean;
  providerKey: string;
  scope: PiariumExtensionServiceRoutingContext;
  serviceId: string;
  version: number;
}

export interface PiariumExtensionServiceRoutingDocument {
  revision: number;
  rules: PiariumExtensionServiceRoutingRule[];
  schemaVersion: typeof PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION;
  updatedAt: string;
}

export interface PiariumExtensionServiceRoutingSnapshot {
  authoritative: boolean;
  diagnostics: PiariumExtensionDiagnostic[];
  document: PiariumExtensionServiceRoutingDocument;
  hostId: string;
  storageState: "missing" | "ready" | "stale";
}

export interface PiariumExtensionServiceRoutingRuleUpdateRequest {
  expectedRevision: number;
  rule: PiariumExtensionServiceRoutingRule;
}

export interface PiariumExtensionServiceRoutingRuleRemoveRequest {
  expectedRevision: number;
  scope: PiariumExtensionServiceRoutingContext;
  serviceId: string;
  version: number;
}

export interface PiariumExtensionServiceRoutingCandidate {
  providerId: string;
  providerKey: string;
}

export interface PiariumExtensionServiceRoutingResolution {
  diagnostics: PiariumExtensionDiagnostic[];
  matchedRule?: PiariumExtensionServiceRoutingRule;
  providerId?: string;
  providerKey?: string;
  status: "ambiguous" | "resolved" | "unavailable";
}

const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SCOPE_FIELDS = [
  "distributionId",
  "profileId",
  "userId",
  "workspaceId",
  "projectId",
  "runtimeId",
  "sessionId",
  "agentId",
  "modelProviderId",
  "modelId",
  "invocationId",
] as const satisfies readonly (keyof PiariumExtensionServiceRoutingContext)[];

const record = (value: unknown): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
};

const serviceId = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (!ID_PATTERN.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
};

const revision = (value: unknown, label: string, allowZero = true): number => {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return Number(value);
};

export const parsePiariumExtensionServiceRoutingContext = (
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): PiariumExtensionServiceRoutingContext => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing context must be an object");
  const context: PiariumExtensionServiceRoutingContext = {};
  for (const field of SCOPE_FIELDS) {
    if (raw[field] !== undefined) context[field] = text(raw[field], `scope.${field}`);
  }
  if (!options.allowEmpty && Object.keys(context).length === 0) throw new Error("Service routing scope must select at least one context dimension");
  return context;
};

export const parsePiariumExtensionServiceRoutingRule = (value: unknown): PiariumExtensionServiceRoutingRule => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing rule must be an object");
  if (typeof raw.allowFallback !== "boolean") throw new Error("Service routing rule allowFallback must be boolean");
  return {
    allowFallback: raw.allowFallback,
    providerKey: text(raw.providerKey, "providerKey"),
    scope: parsePiariumExtensionServiceRoutingContext(raw.scope),
    serviceId: serviceId(raw.serviceId, "serviceId"),
    version: revision(raw.version, "version", false),
  };
};

export const serviceRoutingScopeKey = (scopeValue: PiariumExtensionServiceRoutingContext | unknown): string => {
  const scope = parsePiariumExtensionServiceRoutingContext(scopeValue);
  return SCOPE_FIELDS.flatMap((field) => scope[field] ? [`${field}=${JSON.stringify(scope[field])}`] : []).join("&");
};

export const serviceRoutingRuleKey = (
  rule: Pick<PiariumExtensionServiceRoutingRule, "scope" | "serviceId" | "version">,
): string => `${rule.serviceId}@${rule.version}\0${serviceRoutingScopeKey(rule.scope)}`;

export const parsePiariumExtensionServiceRoutingDocument = (
  value: unknown,
): PiariumExtensionServiceRoutingDocument => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing document must be an object");
  if (raw.schemaVersion !== PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION) throw new Error("Service routing schemaVersion is unsupported");
  if (!Array.isArray(raw.rules)) throw new Error("Service routing rules must be an array");
  const rules = raw.rules.map(parsePiariumExtensionServiceRoutingRule);
  const keys = rules.map(serviceRoutingRuleKey);
  if (new Set(keys).size !== keys.length) throw new Error("Service routing rule identities must be unique");
  const updatedAt = text(raw.updatedAt, "updatedAt");
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error("updatedAt must be an ISO timestamp");
  return {
    revision: revision(raw.revision, "revision"),
    rules,
    schemaVersion: PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION,
    updatedAt,
  };
};

export const parsePiariumExtensionServiceRoutingSnapshot = (
  value: unknown,
): PiariumExtensionServiceRoutingSnapshot => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing snapshot must be an object");
  const storageState = raw.storageState;
  if (storageState !== "missing" && storageState !== "ready" && storageState !== "stale") {
    throw new Error("Service routing storageState is unsupported");
  }
  if (typeof raw.authoritative !== "boolean") throw new Error("Service routing authoritative must be boolean");
  if (!Array.isArray(raw.diagnostics)) throw new Error("Service routing diagnostics must be an array");
  return {
    authoritative: raw.authoritative,
    diagnostics: raw.diagnostics as PiariumExtensionDiagnostic[],
    document: parsePiariumExtensionServiceRoutingDocument(raw.document),
    hostId: text(raw.hostId, "hostId"),
    storageState,
  };
};

export const parsePiariumExtensionServiceRoutingRuleUpdateRequest = (
  value: unknown,
): PiariumExtensionServiceRoutingRuleUpdateRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing update request must be an object");
  return { expectedRevision: revision(raw.expectedRevision, "expectedRevision"), rule: parsePiariumExtensionServiceRoutingRule(raw.rule) };
};

export const parsePiariumExtensionServiceRoutingRuleRemoveRequest = (
  value: unknown,
): PiariumExtensionServiceRoutingRuleRemoveRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing remove request must be an object");
  return {
    expectedRevision: revision(raw.expectedRevision, "expectedRevision"),
    scope: parsePiariumExtensionServiceRoutingContext(raw.scope),
    serviceId: serviceId(raw.serviceId, "serviceId"),
    version: revision(raw.version, "version", false),
  };
};

export const defaultPiariumExtensionServiceRoutingDocument = (): PiariumExtensionServiceRoutingDocument => ({
  revision: 0,
  rules: [],
  schemaVersion: PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
});

export const serviceRoutingDocumentFromStorage = (
  snapshot: PiariumExtensionStorageSnapshot,
): PiariumExtensionServiceRoutingDocument => parsePiariumExtensionServiceRoutingDocument({
  ...(snapshot.exists ? snapshot.document.data : defaultPiariumExtensionServiceRoutingDocument()),
  revision: snapshot.document.revision,
  schemaVersion: PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION,
  updatedAt: snapshot.document.updatedAt,
});

const precedence = (scope: PiariumExtensionServiceRoutingContext): [number, number] => {
  let highest = -1;
  let dimensions = 0;
  SCOPE_FIELDS.forEach((field, index) => {
    if (scope[field] === undefined) return;
    highest = Math.max(highest, index);
    dimensions += 1;
  });
  return [highest, dimensions];
};

const matchesContext = (
  scope: PiariumExtensionServiceRoutingContext,
  context: PiariumExtensionServiceRoutingContext,
): boolean => SCOPE_FIELDS.every((field) => scope[field] === undefined || scope[field] === context[field]);

const routingDiagnostic = (code: string, message: string): PiariumExtensionDiagnostic => ({
  code,
  message,
  severity: code.includes("fallback") ? "warning" : "error",
  timestamp: new Date().toISOString(),
});

export const resolvePiariumExtensionServiceRouting = (options: {
  candidates: readonly PiariumExtensionServiceRoutingCandidate[];
  context?: PiariumExtensionServiceRoutingContext;
  document: PiariumExtensionServiceRoutingDocument | unknown;
  serviceId: string;
  version: number;
}): PiariumExtensionServiceRoutingResolution => {
  const document = parsePiariumExtensionServiceRoutingDocument(options.document);
  const context = parsePiariumExtensionServiceRoutingContext(options.context ?? {}, { allowEmpty: true });
  const id = serviceId(options.serviceId, "serviceId");
  const version = revision(options.version, "version", false);
  const candidates = options.candidates.filter((candidate) => candidate.providerId.trim() && candidate.providerKey.trim());
  const matching = document.rules.filter((rule) => (
    rule.serviceId === id && rule.version === version && matchesContext(rule.scope, context)
  )).sort((left, right) => {
    const leftPrecedence = precedence(left.scope);
    const rightPrecedence = precedence(right.scope);
    return rightPrecedence[0] - leftPrecedence[0] || rightPrecedence[1] - leftPrecedence[1];
  });
  const diagnostics: PiariumExtensionDiagnostic[] = [];
  for (let index = 0; index < matching.length;) {
    const rank = precedence(matching[index]!.scope);
    const peers: PiariumExtensionServiceRoutingRule[] = [];
    while (index < matching.length) {
      const current = matching[index] as PiariumExtensionServiceRoutingRule;
      const currentRank = precedence(current.scope);
      if (currentRank[0] !== rank[0] || currentRank[1] !== rank[1]) break;
      peers.push(current);
      index += 1;
    }
    const providerKeys = new Set(peers.map((rule) => rule.providerKey));
    if (providerKeys.size > 1) {
      return {
        diagnostics: [routingDiagnostic(
          "service_selection_scope_conflict",
          `Multiple equally specific routing rules select different providers for ${id}@${version}`,
        )],
        status: "ambiguous",
      };
    }
    const rule = peers[0] as PiariumExtensionServiceRoutingRule;
    const provider = candidates.find((candidate) => candidate.providerKey === rule.providerKey);
    if (provider) {
      return {
        diagnostics,
        matchedRule: rule,
        providerId: provider.providerId,
        providerKey: provider.providerKey,
        status: "resolved",
      };
    }
    diagnostics.push(routingDiagnostic(
      rule.allowFallback ? "service_selection_fallback" : "service_selection_provider_unavailable",
      `Selected provider ${rule.providerKey} is unavailable for ${id}@${version}`,
    ));
    if (!rule.allowFallback) return { diagnostics, matchedRule: rule, providerKey: rule.providerKey, status: "unavailable" };
  }
  if (candidates.length === 1) {
    const candidate = candidates[0] as PiariumExtensionServiceRoutingCandidate;
    return {
      diagnostics,
      providerId: candidate.providerId,
      providerKey: candidate.providerKey,
      status: "resolved",
    };
  }
  if (candidates.length > 1) {
    return {
      diagnostics: [...diagnostics, routingDiagnostic(
        "service_selection_ambiguous",
        `Multiple providers are available for ${id}@${version}; an explicit routing rule is required`,
      )],
      status: "ambiguous",
    };
  }
  return {
    diagnostics: [...diagnostics, routingDiagnostic(
      "service_provider_unavailable",
      `No provider is available for ${id}@${version}`,
    )],
    status: "unavailable",
  };
};
