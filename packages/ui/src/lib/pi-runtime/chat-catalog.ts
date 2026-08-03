import type {
  PiCommandDescriptor,
  PiResourceCatalogSnapshot,
  PiResourceScope,
} from '@piarium/protocol';

export interface PiChatSkill {
  description?: string;
  filePath?: string;
  invocation: string;
  name: string;
  scope: PiResourceScope | 'temporary';
  source: string;
}

export interface PiChatCatalog {
  commands: PiCommandDescriptor[];
  skills: PiChatSkill[];
}

const SKILL_INVOCATION_PREFIX = 'skill:';

const skillNameFromInvocation = (invocation: string): string | null => {
  if (!invocation.startsWith(SKILL_INVOCATION_PREFIX)) return null;
  const name = invocation.slice(SKILL_INVOCATION_PREFIX.length).trim();
  return name || null;
};

/**
 * Join Pi's callable command catalog with its editable skill resources.
 * `command.list` remains the authority for what can be invoked; resource
 * descriptors only enrich those commands with their file and ownership data.
 */
export const buildPiChatCatalog = (
  commands: readonly PiCommandDescriptor[],
  skillCatalog: PiResourceCatalogSnapshot,
): PiChatCatalog => {
  const activeResources = new Map(
    skillCatalog.resources
      .filter((resource) => resource.active && resource.valid)
      .map((resource) => [resource.name, resource] as const),
  );
  const unusableResourceNames = new Set(
    skillCatalog.resources
      .filter((resource) => !resource.active || !resource.valid)
      .map((resource) => resource.name),
  );
  const skills: PiChatSkill[] = [];
  const seenInvocations = new Set<string>();

  for (const command of commands) {
    if (command.source !== 'skill') continue;
    const invocation = command.name.trim();
    const name = skillNameFromInvocation(invocation);
    if (!name || seenInvocations.has(invocation)) continue;
    seenInvocations.add(invocation);

    const resource = activeResources.get(name);
    const fallbackPath = unusableResourceNames.has(name)
      ? undefined
      : command.sourceInfo.path.trim() || undefined;
    const description = resource?.description.trim() || command.description?.trim() || undefined;
    const filePath = resource?.filePath.trim() || fallbackPath;

    skills.push({
      ...(description === undefined ? {} : { description }),
      ...(filePath === undefined ? {} : { filePath }),
      invocation,
      name,
      scope: resource?.sourceInfo.scope ?? command.sourceInfo.scope,
      source: resource?.sourceInfo.source ?? command.sourceInfo.source,
    });
  }

  return { commands: [...commands], skills };
};
