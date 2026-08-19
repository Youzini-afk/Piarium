import type {
  JsonValue,
  PiConfigScope,
  PiConfigTextFormat,
  PiConfigTextRoot,
  PiConfigWatchSubscription,
  PiConfigWatchTarget,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { getPiRuntimeConnection } from './client';
import { getRuntimeKey } from '../runtime-switch';

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
  expectedRevision: string,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('config.document.update', {
    ...target,
    ...changes,
    expectedRevision,
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

type PiConfigWatchEvent = PiConfigWatchSubscription & {
  reason: 'change' | 'error' | 'rename';
};

export const subscribePiConfig = async (
  target: RuntimeContextTarget,
  watchTarget: PiConfigWatchTarget,
  listener: (event: PiConfigWatchEvent) => void,
): Promise<() => Promise<void>> => {
  const connection = await getPiRuntimeConnection();
  const subscription = await connection.client.request('config.watch', {
    ...target,
    target: watchTarget,
  });
  if (connection.runtimeKey !== getRuntimeKey()) {
    if (connection.client.connected) {
      await connection.client.request('config.unwatch', { watchId: subscription.watchId })
        .catch(() => undefined);
    }
    throw new Error('Pi runtime changed while creating the configuration watch');
  }
  let stopped = false;
  const unsubscribe = connection.client.subscribe((event) => {
    if (
      stopped
      || connection.runtimeKey !== getRuntimeKey()
      || event.event !== 'config.changed'
      || event.data.watchId !== subscription.watchId
    ) return;
    listener(event.data);
  });
  return async () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    if (!connection.client.connected) return;
    await connection.client.request('config.unwatch', { watchId: subscription.watchId })
      .catch(() => undefined);
  };
};
