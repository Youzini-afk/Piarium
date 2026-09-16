import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** Native Pi context, not the complete append-only transcript, owns retention. */
export function retainedContextState(entries: readonly SessionEntry[]): {
  observationRefs: string[];
  knownMaterial: Record<string, string>;
  retainedGit: boolean;
} {
  const observationRefs = new Set<string>();
  const knownMaterial: Record<string, string> = {};
  let retainedGit = false;
  for (const message of buildSessionContext([...entries]).messages) {
    if (message.role !== "toolResult" && message.role !== "custom") continue;
    if (message.role === "custom" && message.customType !== "piarium-context") continue;
    const details = message.details as Record<string, unknown> | undefined;
    if (!details || typeof details !== "object") continue;
    if (typeof details.observationRef === "string") observationRefs.add(details.observationRef);
    if (Array.isArray(details.observationRefs)) {
      for (const ref of details.observationRefs) if (typeof ref === "string") observationRefs.add(ref);
    }
    const revisions = details.materialRevisions;
    if (revisions && typeof revisions === "object" && !Array.isArray(revisions)) {
      for (const [key, revision] of Object.entries(revisions)) {
        if (typeof revision === "string") knownMaterial[key] = revision;
      }
    }
    if (details.gitObserved === true) retainedGit = true;
  }
  return { observationRefs: [...observationRefs], knownMaterial, retainedGit };
}
