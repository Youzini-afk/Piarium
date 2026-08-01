import type { JsonValue } from "@piarium/protocol";

export interface TimelineToolCall {
  arguments: JsonValue;
  id: string;
  name: string;
}

export interface TimelineItem {
  customType?: string;
  error?: string;
  id: string;
  images: number;
  kind: "assistant" | "custom" | "meta" | "summary" | "tool" | "user";
  parentId: string | null;
  rawType: string;
  role?: string;
  text: string;
  thinking?: string;
  timestamp?: string;
  toolCallId?: string;
  toolCalls: TimelineToolCall[];
  toolName?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function json(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

function contentParts(value: unknown): {
  images: number;
  text: string;
  thinking?: string;
  toolCalls: TimelineToolCall[];
} {
  if (typeof value === "string") return { images: 0, text: value, toolCalls: [] };
  if (!Array.isArray(value)) return { images: 0, text: "", toolCalls: [] };
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: TimelineToolCall[] = [];
  let images = 0;
  for (const valuePart of value) {
    const part = record(valuePart);
    if (!part) continue;
    switch (part.type) {
      case "text": {
        const partText = string(part.text);
        if (partText) text.push(partText);
        break;
      }
      case "thinking": {
        const partThinking = string(part.thinking);
        if (partThinking) thinking.push(partThinking);
        break;
      }
      case "image":
        images++;
        break;
      case "toolCall": {
        const id = string(part.id);
        const name = string(part.name);
        if (id && name) {
          toolCalls.push({ arguments: json(part.arguments), id, name });
        }
        break;
      }
    }
  }
  return {
    images,
    text: text.join("\n\n"),
    ...(thinking.length === 0 ? {} : { thinking: thinking.join("\n\n") }),
    toolCalls,
  };
}

function preview(value: unknown, maxLength: number = 1_200): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!serialized) return "";
  return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength)}…`;
}

export function normalizeTimeline(entries: JsonValue): TimelineItem[] {
  if (!Array.isArray(entries)) return [];
  const result: TimelineItem[] = [];
  for (const rawEntry of entries) {
    const entry = record(rawEntry);
    if (!entry) continue;
    const id = string(entry.id);
    const rawType = string(entry.type);
    if (!id || !rawType) continue;
    const parentId = entry.parentId === null ? null : (string(entry.parentId) ?? null);
    const timestamp = string(entry.timestamp);
    if (rawType === "message") {
      const message = record(entry.message);
      const role = string(message?.role);
      if (!message || !role) continue;
      const parts = contentParts(message.content);
      if (role === "toolResult") {
        const error = message.isError === true ? parts.text || "Tool execution failed" : undefined;
        const toolCallId = string(message.toolCallId);
        const toolName = string(message.toolName);
        result.push({
          ...(error === undefined ? {} : { error }),
          id,
          images: parts.images,
          kind: "tool",
          parentId,
          rawType,
          role,
          text: parts.text,
          ...(timestamp === undefined ? {} : { timestamp }),
          ...(toolCallId === undefined ? {} : { toolCallId }),
          toolCalls: [],
          ...(toolName === undefined ? {} : { toolName }),
        });
        continue;
      }
      const error = string(message.errorMessage);
      result.push({
        ...(error === undefined ? {} : { error }),
        id,
        images: parts.images,
        kind: role === "user" ? "user" : role === "assistant" ? "assistant" : "custom",
        parentId,
        rawType,
        role,
        text: parts.text,
        ...(parts.thinking === undefined ? {} : { thinking: parts.thinking }),
        ...(timestamp === undefined ? {} : { timestamp }),
        toolCalls: parts.toolCalls,
      });
      continue;
    }
    if (rawType === "custom_message") {
      if (entry.display === false) continue;
      const parts = contentParts(entry.content);
      const customType = string(entry.customType);
      result.push({
        ...(customType === undefined ? {} : { customType }),
        id,
        images: parts.images,
        kind: "custom",
        parentId,
        rawType,
        text: parts.text,
        ...(timestamp === undefined ? {} : { timestamp }),
        toolCalls: [],
      });
      continue;
    }
    if (rawType === "custom") {
      const customType = string(entry.customType);
      result.push({
        ...(customType === undefined ? {} : { customType }),
        id,
        images: 0,
        kind: "custom",
        parentId,
        rawType,
        text: preview(entry.data),
        ...(timestamp === undefined ? {} : { timestamp }),
        toolCalls: [],
      });
      continue;
    }
    if (rawType === "compaction" || rawType === "branch_summary") {
      result.push({
        id,
        images: 0,
        kind: "summary",
        parentId,
        rawType,
        text: string(entry.summary) ?? "Session context summarized",
        ...(timestamp === undefined ? {} : { timestamp }),
        toolCalls: [],
      });
      continue;
    }
    if (rawType === "label" || rawType === "session_info") continue;
    result.push({
      id,
      images: 0,
      kind: "meta",
      parentId,
      rawType,
      text:
        rawType === "model_change"
          ? `Model changed to ${String(entry.provider)}/${String(entry.modelId)}`
          : rawType === "thinking_level_change"
            ? `Thinking level: ${String(entry.thinkingLevel)}`
            : preview(entry),
      ...(timestamp === undefined ? {} : { timestamp }),
      toolCalls: [],
    });
  }
  return result;
}

export function normalizeLiveAssistant(event: unknown): TimelineItem | undefined {
  const data = record(event);
  if (data?.type !== "message_update") return undefined;
  const message = record(data.message);
  if (message?.role !== "assistant") return undefined;
  const parts = contentParts(message.content);
  const error = string(message.errorMessage);
  return {
    ...(error === undefined ? {} : { error }),
    id: "live-assistant",
    images: parts.images,
    kind: "assistant",
    parentId: null,
    rawType: "live",
    role: "assistant",
    text: parts.text,
    ...(parts.thinking === undefined ? {} : { thinking: parts.thinking }),
    toolCalls: parts.toolCalls,
  };
}
