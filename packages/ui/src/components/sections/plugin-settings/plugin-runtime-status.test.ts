import { describe, expect, test } from 'bun:test';
import type { PiAgentProviderDescriptor, RecoveryProviderDescriptor } from '@piarium/protocol';
import { pluginRuntimeStatus, type PluginRuntimeSignals } from './plugin-runtime-status';

const agentProvider = (id: string, available: boolean): PiAgentProviderDescriptor => ({
  actions: [],
  available,
  description: id,
  id,
  label: id,
});

const recoveryProvider = (id: string, active: boolean): RecoveryProviderDescriptor => ({
  actions: [],
  active,
  id,
  modes: [],
  name: id,
});

const signals = (overrides: Partial<PluginRuntimeSignals> = {}): PluginRuntimeSignals => ({
  agentProviders: [],
  agentProvidersChecked: true,
  agentProvidersFailed: false,
  commandNames: new Set(),
  commandsChecked: true,
  commandsFailed: false,
  hasActiveSession: true,
  mcpStatusReported: false,
  recoveryChecked: true,
  recoveryFailed: false,
  recoveryProviders: [],
  ...overrides,
});

describe('plugin runtime status', () => {
  test('does not infer runtime availability without an active session', () => {
    expect(
      pluginRuntimeStatus(
        'subagents',
        signals({
          agentProviders: [agentProvider('pi-subagents', true)],
          hasActiveSession: false,
        }),
      ),
    ).toBe('no-session');
  });

  test('uses provider availability for subagents and Magic Context', () => {
    expect(
      pluginRuntimeStatus(
        'subagents',
        signals({
          agentProviders: [agentProvider('pi-subagents', true)],
        }),
      ),
    ).toBe('available');
    expect(
      pluginRuntimeStatus(
        'magic-context',
        signals({
          agentProviders: [agentProvider('magic-context', false)],
        }),
      ),
    ).toBe('unavailable');
  });

  test('only marks web access available when its session command is observed', () => {
    expect(
      pluginRuntimeStatus(
        'web-access',
        signals({
          commandNames: new Set(['websearch']),
        }),
      ),
    ).toBe('available');
    expect(pluginRuntimeStatus('web-access', signals())).toBe('not-observed');
  });

  test('observes native commands registered by the Codex, memory, and context plugins', () => {
    const commandNames = new Set(['codex-settings', 'om:status', 'ctx-stats']);
    expect(pluginRuntimeStatus('openai-codex-compat', signals({ commandNames }))).toBe('available');
    expect(pluginRuntimeStatus('observational-memory', signals({ commandNames }))).toBe('available');
    expect(pluginRuntimeStatus('context-mode', signals({ commandNames }))).toBe('available');
    expect(pluginRuntimeStatus('openai-codex-compat', signals())).toBe('not-observed');
    expect(pluginRuntimeStatus('observational-memory', signals())).toBe('not-observed');
    expect(pluginRuntimeStatus('context-mode', signals())).toBe('not-observed');
  });

  test('observes pi-lens only when its native toggle command is listed', () => {
    expect(pluginRuntimeStatus('pi-lens', signals({ commandNames: new Set(['lens-toggle']) }))).toBe('available');
    expect(pluginRuntimeStatus('pi-lens', signals())).toBe('not-observed');
    expect(pluginRuntimeStatus('pi-lens', signals({ hasActiveSession: false, commandNames: new Set(['lens-toggle']) }))).toBe('no-session');
  });

  test('observes permission-system only through its native settings command', () => {
    expect(pluginRuntimeStatus(
      'permission-system',
      signals({ commandNames: new Set(['permission-system']) }),
    )).toBe('available');
    expect(pluginRuntimeStatus('permission-system', signals())).toBe('not-observed');
    expect(pluginRuntimeStatus(
      'permission-system',
      signals({ commandNames: new Set(['permissions:decision']) }),
    )).toBe('not-observed');
  });

  test('uses active recovery providers and MCP status reports', () => {
    expect(
      pluginRuntimeStatus(
        'workspace-history',
        signals({
          recoveryProviders: [recoveryProvider('pi-workspace-history', true)],
        }),
      ),
    ).toBe('available');
    expect(
      pluginRuntimeStatus(
        'wtf',
        signals({
          recoveryProviders: [recoveryProvider('pi-wtf', false)],
        }),
      ),
    ).toBe('unavailable');
    expect(pluginRuntimeStatus('mcp', signals({ mcpStatusReported: true }))).toBe('available');
  });

  test('keeps pending probes distinct from an absent runtime report', () => {
    expect(pluginRuntimeStatus('subagents', signals({ agentProvidersChecked: false }))).toBe('checking');
    expect(pluginRuntimeStatus('workspace-history', signals({ recoveryChecked: false }))).toBe('checking');
    expect(pluginRuntimeStatus('mcp', signals())).toBe('not-observed');
  });

  test('does not misreport failed probes as an absent plugin signal', () => {
    expect(pluginRuntimeStatus('subagents', signals({ agentProvidersFailed: true }))).toBe('error');
    expect(pluginRuntimeStatus('web-access', signals({ commandsFailed: true }))).toBe('error');
    expect(pluginRuntimeStatus('wtf', signals({ recoveryFailed: true }))).toBe('error');
  });
});
