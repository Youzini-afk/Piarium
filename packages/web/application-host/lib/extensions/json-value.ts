import type { JsonValue } from '@piarium/extension-contract';
import type { HostCapabilityCallContext } from '@piarium/extension-host';

export interface CapabilityInvocationContext {
  owner?: HostCapabilityCallContext['owner'] | undefined;
}

export type JsonCapabilityHandler = (
  method: string,
  params: unknown,
  context?: CapabilityInvocationContext,
) => Promise<JsonValue>;

export const toJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) result[key] = toJsonValue(entry);
    }
    return result;
  }
  throw new TypeError(`Extension capability returned a non-JSON value (${typeof value})`);
};
