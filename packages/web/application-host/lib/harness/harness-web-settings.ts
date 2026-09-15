import {
  mergeHarnessWebDomainPolicy,
  type HarnessSettings,
  type HarnessWebDomainPolicy,
  type HarnessWebSearchSettings,
  type PiSettingsSnapshot,
} from "@piarium/protocol";

export interface HarnessWebBinding {
  generation: string;
  settings: HarnessSettings["web"];
}

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const webFrom = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return record(record(value).harness).web && typeof record(record(value).harness).web === "object"
    && !Array.isArray(record(record(value).harness).web)
    ? record(record(record(value).harness).web)
    : {};
};

const strings = (value: unknown): string[] | undefined => (
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined
);

const domainsFrom = (value: unknown): Partial<HarnessWebDomainPolicy> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const allow = strings(input.allow);
  const block = strings(input.block);
  return allow === undefined && block === undefined
    ? undefined
    : {
        ...(allow === undefined ? {} : { allow }),
        ...(block === undefined ? {} : { block }),
      };
};

const searchFrom = (value: unknown): HarnessWebSearchSettings | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const provider = input.provider;
  if (provider !== "brave" && provider !== "exa" && provider !== "tavily" && provider !== "jina" && provider !== "searxng") {
    return undefined;
  }
  const endpoint = typeof input.endpoint === "string" && input.endpoint.trim() ? input.endpoint.trim() : undefined;
  const credentialRef = typeof input.credentialRef === "string" && input.credentialRef.trim()
    ? input.credentialRef.trim()
    : undefined;
  return {
    provider,
    ...(endpoint ? { endpoint } : {}),
    ...(credentialRef ? { credentialRef } : {}),
  };
};

/** Freeze credential-free web policy/provider identity for one worker generation. */
export const resolveHarnessWebBinding = (snapshot: PiSettingsSnapshot): HarnessWebBinding => {
  const user = webFrom(snapshot.global);
  const workspace = snapshot.projectTrusted ? webFrom(snapshot.project) : {};
  const render = typeof user.render === "boolean" ? user.render : undefined;
  const search = searchFrom(user.search);
  const domains = mergeHarnessWebDomainPolicy(domainsFrom(user.domains), domainsFrom(workspace.domains));
  const settings: HarnessSettings["web"] = {
    ...(render === undefined ? {} : { render }),
    ...(search ? { search } : {}),
    domains,
  };
  return {
    generation: `${snapshot.globalRevision}:${snapshot.projectTrusted ? snapshot.projectRevision : "untrusted"}`,
    settings,
  };
};
