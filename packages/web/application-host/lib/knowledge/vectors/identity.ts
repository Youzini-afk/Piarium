import { contentHashOf } from "../semantic/identity.js";

export const knowledgeEmbedText = (content: string, trigger: string): string => {
  const trimmed = trigger.trim();
  return trimmed.length === 0 ? content : `Trigger: ${trimmed}\n\n${content}`;
};

export const knowledgeContentRevision = (content: string, trigger: string): string => (
  contentHashOf(`${content}\0${trigger}`)
);
