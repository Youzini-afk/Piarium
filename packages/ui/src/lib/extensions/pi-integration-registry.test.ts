import { expect, mock, test } from 'bun:test';
import { PIARIUM_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS } from '@piarium/extension-builtins';
import { SurfaceExtensionRuntime } from '@piarium/extension-surface';
import type { PackageDescriptor } from '@piarium/protocol';

mock.module('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ hasLogo: false, onError: () => undefined, src: null }),
}));

const { activateBuiltinPiIntegration } = await import('./builtin-pi-integrations');
const { pluginSettingsAdapterForPackage, pluginSettingsAdaptersFromSnapshot } = await import('./pi-integration-registry');

test('a Piarium adapter contribution can be withdrawn without changing the Pi package', async () => {
  const definition = PIARIUM_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS.find((candidate) => (
    candidate.manifest.id.endsWith('.subagents')
  ));
  expect(definition).toBeDefined();
  if (!definition) return;
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const handle = await runtime.activate({
    owner: {
      desiredRevision: 1,
      entrypointId: 'main',
      extensionId: definition.manifest.id,
      extensionVersion: definition.manifest.version,
      generation: 1,
      hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
      realmId: 'adapter-test',
    },
  }, activateBuiltinPiIntegration(definition));
  const piPackage: PackageDescriptor = {
    enabled: true,
    installed: true,
    name: 'pi-subagents',
    scope: 'global',
    source: 'npm:pi-subagents',
    structured: true,
  };

  const activeAdapters = pluginSettingsAdaptersFromSnapshot(runtime.getSnapshot());
  expect(pluginSettingsAdapterForPackage(piPackage, activeAdapters)?.adapterId).toBe('subagents');
  await handle.deactivate(2, 2);
  expect(pluginSettingsAdapterForPackage(piPackage, pluginSettingsAdaptersFromSnapshot(runtime.getSnapshot()))).toBe(null);
  expect(piPackage.enabled).toBe(true);
  expect(piPackage.installed).toBe(true);
});

test('maps the pi-lens package to its built-in settings adapter', async () => {
  const definition = PIARIUM_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS.find((candidate) => (
    candidate.manifest.id.endsWith('.pi-lens')
  ));
  expect(definition).toBeDefined();
  if (!definition) return;
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const handle = await runtime.activate({
    owner: {
      desiredRevision: 1,
      entrypointId: 'main',
      extensionId: definition.manifest.id,
      extensionVersion: definition.manifest.version,
      generation: 1,
      hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
      realmId: 'pi-lens-adapter-test',
    },
  }, activateBuiltinPiIntegration(definition));
  const piPackage: PackageDescriptor = {
    enabled: true,
    installed: true,
    name: 'pi-lens',
    scope: 'global',
    source: 'npm:pi-lens',
    structured: true,
  };
  expect(pluginSettingsAdapterForPackage(
    piPackage,
    pluginSettingsAdaptersFromSnapshot(runtime.getSnapshot()),
  )?.adapterId).toBe('pi-lens');
  await handle.deactivate(2, 2);
});

test('maps @gotgenes/pi-permission-system to its built-in settings adapter', async () => {
  const definition = PIARIUM_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS.find((candidate) => (
    candidate.manifest.id.endsWith('.permission-system')
  ));
  expect(definition).toBeDefined();
  if (!definition) return;
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const handle = await runtime.activate({
    owner: {
      desiredRevision: 1,
      entrypointId: 'main',
      extensionId: definition.manifest.id,
      extensionVersion: definition.manifest.version,
      generation: 1,
      hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
      realmId: 'permission-system-adapter-test',
    },
  }, activateBuiltinPiIntegration(definition));
  const piPackage: PackageDescriptor = {
    enabled: true,
    installed: true,
    name: '@gotgenes/pi-permission-system',
    scope: 'global',
    source: 'npm:@gotgenes/pi-permission-system',
    structured: true,
  };
  expect(pluginSettingsAdapterForPackage(
    piPackage,
    pluginSettingsAdaptersFromSnapshot(runtime.getSnapshot()),
  )?.adapterId).toBe('permission-system');
  await handle.deactivate(2, 2);
});
