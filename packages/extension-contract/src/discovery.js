export const PIARIUM_EXTENSION_DISCOVERY_SCHEMA_VERSION = 1;
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SOURCE_KINDS = new Set(["builtin", "git", "local", "npm"]);
const record = (value) => (typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null);
const text = (value, label) => {
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error(`${label} must be a non-empty string`);
    return value.trim();
};
const optionalText = (value, label) => (value === undefined ? undefined : text(value, label));
const parseSource = (value, label) => {
    const raw = record(value);
    if (!raw)
        throw new Error(`${label} must be an object`);
    const kind = text(raw.kind, `${label}.kind`);
    if (!SOURCE_KINDS.has(kind))
        throw new Error(`${label}.kind is unsupported`);
    return {
        display: text(raw.display, `${label}.display`),
        kind,
        specifier: text(raw.specifier, `${label}.specifier`),
    };
};
export const parsePiariumExtensionDiscoveryDocument = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Piarium extension discovery document must be an object");
    if (raw.schemaVersion !== PIARIUM_EXTENSION_DISCOVERY_SCHEMA_VERSION) {
        throw new Error("Piarium extension discovery schemaVersion is unsupported");
    }
    if (!Array.isArray(raw.entries))
        throw new Error("Piarium extension discovery entries must be an array");
    const entries = raw.entries.map((value, index) => {
        const entry = record(value);
        if (!entry)
            throw new Error(`entries[${index}] must be an object`);
        const id = text(entry.id, `entries[${index}].id`);
        if (!ID_PATTERN.test(id))
            throw new Error(`entries[${index}].id is invalid`);
        let keywords;
        if (entry.keywords !== undefined) {
            if (!Array.isArray(entry.keywords))
                throw new Error(`entries[${index}].keywords must be an array`);
            keywords = entry.keywords.map((item, keywordIndex) => text(item, `entries[${index}].keywords[${keywordIndex}]`));
            if (new Set(keywords).size !== keywords.length)
                throw new Error(`entries[${index}].keywords contains duplicates`);
        }
        const description = optionalText(entry.description, `entries[${index}].description`);
        const displayName = optionalText(entry.displayName, `entries[${index}].displayName`);
        const homepage = optionalText(entry.homepage, `entries[${index}].homepage`);
        const icon = optionalText(entry.icon, `entries[${index}].icon`);
        return {
            id,
            source: parseSource(entry.source, `entries[${index}].source`),
            ...(description ? { description } : {}),
            ...(displayName ? { displayName } : {}),
            ...(homepage ? { homepage } : {}),
            ...(icon ? { icon } : {}),
            ...(keywords ? { keywords } : {}),
        };
    });
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
        throw new Error("Piarium extension discovery entry IDs must be unique");
    }
    return { entries, schemaVersion: PIARIUM_EXTENSION_DISCOVERY_SCHEMA_VERSION };
};
//# sourceMappingURL=discovery.js.map