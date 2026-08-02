import type {
  PiResourceKind,
  PiResourceScope,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { getPiRuntimeConnection } from './client';

export const listPiResources = async (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('resource.list', { ...target, kind });
};

export const getPiResource = async (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
  id: string,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('resource.get', { ...target, id, kind });
};

export const createPiResource = async (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
  scope: PiResourceScope,
  name: string,
  content: string,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('resource.create', { ...target, content, kind, name, scope });
};

export const updatePiResource = async (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
  id: string,
  content: string,
  expectedRevision: string,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('resource.update', {
    ...target,
    content,
    expectedRevision,
    id,
    kind,
  });
};

export const deletePiResource = async (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
  id: string,
  expectedRevision: string,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('resource.delete', { ...target, expectedRevision, id, kind });
};

export const copyPiResource = async (
  target: RuntimeContextTarget,
  kind: PiResourceKind,
  id: string,
  scope: PiResourceScope,
  name?: string,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('resource.copy', {
    ...target,
    id,
    kind,
    scope,
    ...(name?.trim() ? { name: name.trim() } : {}),
  });
};
