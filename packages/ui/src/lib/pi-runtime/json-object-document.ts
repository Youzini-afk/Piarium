import type { JsonValue } from '@piarium/protocol';

export type PiJsonObjectDocument = { [key: string]: JsonValue };

export function parsePiJsonObjectDocument(value: string): PiJsonObjectDocument {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Pi configuration must contain a JSON object');
  }
  return parsed as PiJsonObjectDocument;
}

export function formatPiJsonObjectDocument(value: PiJsonObjectDocument): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface PiJsonObjectChanges {
  remove: string[];
  set: PiJsonObjectDocument;
}

export function createPiJsonObjectChanges(
  previous: PiJsonObjectDocument,
  next: PiJsonObjectDocument,
): PiJsonObjectChanges {
  const changes: PiJsonObjectChanges = { remove: [], set: {} };
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (!(key in next)) {
      changes.remove.push(key);
      continue;
    }
    if (!(key in previous) || JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      changes.set[key] = next[key] as JsonValue;
    }
  }
  return changes;
}
