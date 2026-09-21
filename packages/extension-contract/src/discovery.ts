import type { VarinExtensionPackageSource } from "./types.js";

export const VARIN_EXTENSION_DISCOVERY_SCHEMA_VERSION = 1 as const;

export interface VarinExtensionDiscoveryEntry {
  description?: string;
  displayName?: string;
  homepage?: string;
  icon?: string;
  id: string;
  keywords?: string[];
  source: VarinExtensionPackageSource;
}

export interface VarinExtensionDiscoveryDocument {
  entries: VarinExtensionDiscoveryEntry[];
  schemaVersion: typeof VARIN_EXTENSION_DISCOVERY_SCHEMA_VERSION;
}

const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SOURCE_KINDS = new Set<VarinExtensionPackageSource["kind"]>(["builtin", "git", "local", "npm"]);

const record = (value: unknown): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
};

const optionalText = (value: unknown, label: string): string | undefined => (
  value === undefined ? undefined : text(value, label)
);

const parseSource = (value: unknown, label: string): VarinExtensionPackageSource => {
  const raw = record(value);
  if (!raw) throw new Error(`${label} must be an object`);
  const kind = text(raw.kind, `${label}.kind`) as VarinExtensionPackageSource["kind"];
  if (!SOURCE_KINDS.has(kind)) throw new Error(`${label}.kind is unsupported`);
  return {
    display: text(raw.display, `${label}.display`),
    kind,
    specifier: text(raw.specifier, `${label}.specifier`),
  };
};

export const parseVarinExtensionDiscoveryDocument = (
  value: unknown,
): VarinExtensionDiscoveryDocument => {
  const raw = record(value);
  if (!raw) throw new Error("Varin extension discovery document must be an object");
  if (raw.schemaVersion !== VARIN_EXTENSION_DISCOVERY_SCHEMA_VERSION) {
    throw new Error("Varin extension discovery schemaVersion is unsupported");
  }
  if (!Array.isArray(raw.entries)) throw new Error("Varin extension discovery entries must be an array");
  const entries = raw.entries.map<VarinExtensionDiscoveryEntry>((value, index) => {
    const entry = record(value);
    if (!entry) throw new Error(`entries[${index}] must be an object`);
    const id = text(entry.id, `entries[${index}].id`);
    if (!ID_PATTERN.test(id)) throw new Error(`entries[${index}].id is invalid`);
    let keywords: string[] | undefined;
    if (entry.keywords !== undefined) {
      if (!Array.isArray(entry.keywords)) throw new Error(`entries[${index}].keywords must be an array`);
      keywords = entry.keywords.map((item, keywordIndex) => text(item, `entries[${index}].keywords[${keywordIndex}]`));
      if (new Set(keywords).size !== keywords.length) throw new Error(`entries[${index}].keywords contains duplicates`);
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
    throw new Error("Varin extension discovery entry IDs must be unique");
  }
  return { entries, schemaVersion: VARIN_EXTENSION_DISCOVERY_SCHEMA_VERSION };
};
