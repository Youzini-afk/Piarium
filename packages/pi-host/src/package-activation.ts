import type { PackageSource } from "@earendil-works/pi-coding-agent";

const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;
const SAVED_FILTERS_KEY = "piariumDisabledResources";

type ResourceKey = (typeof RESOURCE_KEYS)[number];
interface SavedPackageState extends Partial<Record<ResourceKey, string[] | null>> {
  autoload: boolean | null;
}
type PackageSourceObject = Exclude<PackageSource, string>;
type PiariumPackageSource = PackageSourceObject & {
  [SAVED_FILTERS_KEY]?: SavedPackageState;
};

export function packageSourceValue(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

export function packageSourceEnabled(entry: PackageSource): boolean {
  if (typeof entry === "string") return true;
  const saved = (entry as PiariumPackageSource)[SAVED_FILTERS_KEY];
  if (saved) return false;
  return entry.autoload === false
    || !RESOURCE_KEYS.every((key) => entry[key]?.length === 0);
}

export function setPackageSourceEnabled(entry: PackageSource, enabled: boolean): PackageSource {
  const source = packageSourceValue(entry);
  if (!enabled) {
    if (!packageSourceEnabled(entry)) return entry;
    const current = typeof entry === "string" ? { source } : entry;
    const saved = {
      autoload: current.autoload ?? null,
      ...Object.fromEntries(RESOURCE_KEYS.map((key) => [
        key,
        current[key] === undefined ? null : [...current[key]],
      ])),
    } as SavedPackageState;
    const disabled: PiariumPackageSource = {
      ...current,
      autoload: true,
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      [SAVED_FILTERS_KEY]: saved,
    };
    return disabled as PackageSource;
  }

  if (typeof entry === "string") return entry;
  const saved = (entry as PiariumPackageSource)[SAVED_FILTERS_KEY];
  if (!saved) {
    if (packageSourceEnabled(entry)) return entry;
    const restored: PiariumPackageSource = { ...entry };
    for (const key of RESOURCE_KEYS) delete restored[key];
    if (
      restored.autoload === undefined
      && Object.keys(restored).length === 1
    ) return source;
    return restored;
  }
  const restored: PiariumPackageSource = { ...entry };
  delete restored[SAVED_FILTERS_KEY];
  if (saved.autoload === null) delete restored.autoload;
  else restored.autoload = saved.autoload;
  for (const key of RESOURCE_KEYS) {
    const value = saved[key];
    if (value === null || value === undefined) delete restored[key];
    else restored[key] = [...value];
  }
  if (
    restored.autoload === undefined
    && Object.keys(restored).length === 1
  ) return source;
  return restored;
}
