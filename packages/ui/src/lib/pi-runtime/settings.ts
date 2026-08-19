import type {
  JsonValue,
  PiConfigScope,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { getPiRuntimeConnection } from './client';

export const getPiSettings = async (target: RuntimeContextTarget) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('settings.get', target);
};

export const updatePiSettings = async (
  target: RuntimeContextTarget,
  scope: PiConfigScope,
  changes: { remove: string[]; set: { [key: string]: JsonValue } },
  expectedRevision: string,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('settings.update', {
    ...target,
    ...changes,
    expectedRevision,
    scope,
  });
};
