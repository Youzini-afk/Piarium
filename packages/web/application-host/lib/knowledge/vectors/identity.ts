import { createHash } from "node:crypto";
import { join } from "node:path";
import { contentHashOf } from "../semantic/identity.js";
import type { KnowledgeScope } from "../store.js";

export const knowledgeEmbedText = (content: string, trigger: string): string => {
  const trimmed = trigger.trim();
  return trimmed.length === 0 ? content : `Trigger: ${trimmed}\n\n${content}`;
};

export const knowledgeContentRevision = (content: string, trigger: string): string => (
  contentHashOf(`${content}\0${trigger}`)
);

export const knowledgeVectorRoot = (dataDir: string, hostId: string): string => (
  join(dataDir, "knowledge", hostId, "knowledge-vectors")
);

export const knowledgeVectorSpaceDir = (
  dataDir: string,
  hostId: string,
  scope: KnowledgeScope,
  scopeId: string,
  spaceId: string,
): string => join(knowledgeVectorRoot(dataDir, hostId), scope, scopeId, spaceId);

export const digest16 = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);
