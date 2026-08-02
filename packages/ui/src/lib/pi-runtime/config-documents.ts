import type {
  JsonValue,
  PiConfigScope,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { getPiRuntimeConnection } from './client';

export const getPiConfigDocument = async (
  target: RuntimeContextTarget,
  scope: PiConfigScope,
  path: string,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('config.document.get', { ...target, path, scope });
};

export const updatePiConfigDocument = async (
  target: RuntimeContextTarget,
  scope: PiConfigScope,
  path: string,
  changes: { remove: string[]; set: { [key: string]: JsonValue } },
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('config.document.update', {
    ...target,
    ...changes,
    path,
    scope,
  });
};
