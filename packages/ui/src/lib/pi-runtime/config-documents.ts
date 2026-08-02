import type {
  JsonValue,
  PiConfigScope,
  PiConfigTextFormat,
  PiConfigTextRoot,
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

export const getPiConfigTextDocument = async (
  target: RuntimeContextTarget,
  root: PiConfigTextRoot,
  path: string,
  format: PiConfigTextFormat,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('config.text.get', { ...target, format, path, root });
};

export const updatePiConfigTextDocument = async (
  target: RuntimeContextTarget,
  root: PiConfigTextRoot,
  path: string,
  format: PiConfigTextFormat,
  content: string,
  expectedRevision: string,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('config.text.update', {
    ...target,
    content,
    expectedRevision,
    format,
    path,
    root,
  });
};
