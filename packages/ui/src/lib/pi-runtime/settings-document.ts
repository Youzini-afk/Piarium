import type { JsonValue } from '@piarium/protocol';

export type PiSettingsDocument = { [key: string]: JsonValue };

export function parsePiSettingsDocument(value: string): PiSettingsDocument {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Pi settings must contain a JSON object');
  }
  return parsed as PiSettingsDocument;
}

export function formatPiSettingsDocument(value: PiSettingsDocument): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface PiSettingsChanges {
  remove: string[];
  set: PiSettingsDocument;
}

export function createPiSettingsChanges(
  previous: PiSettingsDocument,
  next: PiSettingsDocument,
): PiSettingsChanges {
  const changes: PiSettingsChanges = { remove: [], set: {} };
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
