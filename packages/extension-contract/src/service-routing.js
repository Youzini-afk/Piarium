export const PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION = 1;
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
];
const record = (value) => (typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null);
const text = (value, label) => {
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error(`${label} must be a non-empty string`);
    return value.trim();
};
const serviceId = (value, label) => {
    const parsed = text(value, label);
    if (!ID_PATTERN.test(parsed))
        throw new Error(`${label} is invalid`);
    return parsed;
};
const revision = (value, label, allowZero = true) => {
    if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
        throw new Error(`${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
    }
    return Number(value);
};
export const parsePiariumExtensionServiceRoutingContext = (value, options = {}) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Service routing context must be an object");
    const context = {};
    for (const field of SCOPE_FIELDS) {
        if (raw[field] !== undefined)
            context[field] = text(raw[field], `scope.${field}`);
    }
    if (!options.allowEmpty && Object.keys(context).length === 0)
        throw new Error("Service routing scope must select at least one context dimension");
    return context;
};
export const parsePiariumExtensionServiceRoutingRule = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Service routing rule must be an object");
    if (typeof raw.allowFallback !== "boolean")
        throw new Error("Service routing rule allowFallback must be boolean");
    return {
        allowFallback: raw.allowFallback,
        providerKey: text(raw.providerKey, "providerKey"),
        scope: parsePiariumExtensionServiceRoutingContext(raw.scope),
        serviceId: serviceId(raw.serviceId, "serviceId"),
        version: revision(raw.version, "version", false),
    };
};
export const serviceRoutingScopeKey = (scopeValue) => {
    const scope = parsePiariumExtensionServiceRoutingContext(scopeValue);
    return SCOPE_FIELDS.flatMap((field) => scope[field] ? [`${field}=${JSON.stringify(scope[field])}`] : []).join("&");
};
export const serviceRoutingRuleKey = (rule) => `${rule.serviceId}@${rule.version}\0${serviceRoutingScopeKey(rule.scope)}`;
export const parsePiariumExtensionServiceRoutingDocument = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Service routing document must be an object");
    if (raw.schemaVersion !== PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION)
        throw new Error("Service routing schemaVersion is unsupported");
    if (!Array.isArray(raw.rules))
        throw new Error("Service routing rules must be an array");
    const rules = raw.rules.map(parsePiariumExtensionServiceRoutingRule);
    const keys = rules.map(serviceRoutingRuleKey);
    if (new Set(keys).size !== keys.length)
        throw new Error("Service routing rule identities must be unique");
    const updatedAt = text(raw.updatedAt, "updatedAt");
    if (!Number.isFinite(Date.parse(updatedAt)))
        throw new Error("updatedAt must be an ISO timestamp");
    return {
        revision: revision(raw.revision, "revision"),
        rules,
        schemaVersion: PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION,
        updatedAt,
    };
};
export const parsePiariumExtensionServiceRoutingSnapshot = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Service routing snapshot must be an object");
    const storageState = raw.storageState;
    if (storageState !== "missing" && storageState !== "ready" && storageState !== "stale") {
        throw new Error("Service routing storageState is unsupported");
    }
    if (typeof raw.authoritative !== "boolean")
        throw new Error("Service routing authoritative must be boolean");
    if (!Array.isArray(raw.diagnostics))
        throw new Error("Service routing diagnostics must be an array");
    return {
        authoritative: raw.authoritative,
        diagnostics: raw.diagnostics,
        document: parsePiariumExtensionServiceRoutingDocument(raw.document),
        hostId: text(raw.hostId, "hostId"),
        storageState,
    };
};
export const parsePiariumExtensionServiceRoutingRuleUpdateRequest = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Service routing update request must be an object");
    return { expectedRevision: revision(raw.expectedRevision, "expectedRevision"), rule: parsePiariumExtensionServiceRoutingRule(raw.rule) };
};
export const parsePiariumExtensionServiceRoutingRuleRemoveRequest = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Service routing remove request must be an object");
    return {
        expectedRevision: revision(raw.expectedRevision, "expectedRevision"),
        scope: parsePiariumExtensionServiceRoutingContext(raw.scope),
        serviceId: serviceId(raw.serviceId, "serviceId"),
        version: revision(raw.version, "version", false),
    };
};
export const defaultPiariumExtensionServiceRoutingDocument = () => ({
    revision: 0,
    rules: [],
    schemaVersion: PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
});
export const serviceRoutingDocumentFromStorage = (snapshot) => parsePiariumExtensionServiceRoutingDocument({
    ...(snapshot.exists ? snapshot.document.data : defaultPiariumExtensionServiceRoutingDocument()),
    revision: snapshot.document.revision,
    schemaVersion: PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION,
    updatedAt: snapshot.document.updatedAt,
});
const precedence = (scope) => {
    let highest = -1;
    let dimensions = 0;
    SCOPE_FIELDS.forEach((field, index) => {
        if (scope[field] === undefined)
            return;
        highest = Math.max(highest, index);
        dimensions += 1;
    });
    return [highest, dimensions];
};
const matchesContext = (scope, context) => SCOPE_FIELDS.every((field) => scope[field] === undefined || scope[field] === context[field]);
const routingDiagnostic = (code, message) => ({
    code,
    message,
    severity: code.includes("fallback") ? "warning" : "error",
    timestamp: new Date().toISOString(),
});
export const resolvePiariumExtensionServiceRouting = (options) => {
    const document = parsePiariumExtensionServiceRoutingDocument(options.document);
    const context = parsePiariumExtensionServiceRoutingContext(options.context ?? {}, { allowEmpty: true });
    const id = serviceId(options.serviceId, "serviceId");
    const version = revision(options.version, "version", false);
    const candidates = options.candidates.filter((candidate) => candidate.providerId.trim() && candidate.providerKey.trim());
    const matching = document.rules.filter((rule) => (rule.serviceId === id && rule.version === version && matchesContext(rule.scope, context))).sort((left, right) => {
        const leftPrecedence = precedence(left.scope);
        const rightPrecedence = precedence(right.scope);
        return rightPrecedence[0] - leftPrecedence[0] || rightPrecedence[1] - leftPrecedence[1];
    });
    const diagnostics = [];
    for (let index = 0; index < matching.length;) {
        const rank = precedence(matching[index].scope);
        const peers = [];
        while (index < matching.length) {
            const current = matching[index];
            const currentRank = precedence(current.scope);
            if (currentRank[0] !== rank[0] || currentRank[1] !== rank[1])
                break;
            peers.push(current);
            index += 1;
        }
        const providerKeys = new Set(peers.map((rule) => rule.providerKey));
        if (providerKeys.size > 1) {
            return {
                diagnostics: [routingDiagnostic("service_selection_scope_conflict", `Multiple equally specific routing rules select different providers for ${id}@${version}`)],
                status: "ambiguous",
            };
        }
        const rule = peers[0];
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
        diagnostics.push(routingDiagnostic(rule.allowFallback ? "service_selection_fallback" : "service_selection_provider_unavailable", `Selected provider ${rule.providerKey} is unavailable for ${id}@${version}`));
        if (!rule.allowFallback)
            return { diagnostics, matchedRule: rule, providerKey: rule.providerKey, status: "unavailable" };
    }
    if (candidates.length === 1) {
        const candidate = candidates[0];
        return {
            diagnostics,
            providerId: candidate.providerId,
            providerKey: candidate.providerKey,
            status: "resolved",
        };
    }
    if (candidates.length > 1) {
        return {
            diagnostics: [...diagnostics, routingDiagnostic("service_selection_ambiguous", `Multiple providers are available for ${id}@${version}; an explicit routing rule is required`)],
            status: "ambiguous",
        };
    }
    return {
        diagnostics: [...diagnostics, routingDiagnostic("service_provider_unavailable", `No provider is available for ${id}@${version}`)],
        status: "unavailable",
    };
};
//# sourceMappingURL=service-routing.js.map