import type {
  JsonValue,
  PiSettingsScope,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { getPiRuntimeConnection } from './client';

export const getPiSettings = async (target: RuntimeContextTarget) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('settings.get', target);
};

export const updatePiSettings = async (
  target: RuntimeContextTarget,
  scope: PiSettingsScope,
  changes: { remove: string[]; set: { [key: string]: JsonValue } },
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('settings.update', { ...target, ...changes, scope });
};
