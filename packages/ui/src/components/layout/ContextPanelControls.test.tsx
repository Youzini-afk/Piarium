import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/useUIStore';
import { ContextPanelControls } from './ContextPanelControls';

vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

let root: Root;
let container: HTMLElement;
beforeEach(async () => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useUIStore.setState({ contextPanelByDirectory: {}, isContextRailOpen: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<ContextPanelControls />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const click = async (label: string) => {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
};

it('toggles the icon rail independently of the content panel', async () => {
  await click('contextRail.actions.expand');
  expect(useUIStore.getState().isContextRailOpen).toBe(true);
  expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBeUndefined();
  await click('contextPanel.actions.openPanel');
  expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0]?.mode).toBe('file');
  await click('contextRail.actions.collapse');
  expect(useUIStore.getState().isContextRailOpen).toBe(false);
  expect(useUIStore.getState().contextPanelByDirectory['/repo']?.isOpen).toBe(true);
  await click('contextPanel.actions.closePanel');
  expect(useUIStore.getState().contextPanelByDirectory['/repo']?.isOpen).toBe(false);
});

it('restores the exact last tab and its layout instead of choosing a new surface', async () => {
  await act(async () => {
    const store = useUIStore.getState();
    store.openContextFile('/repo', '/repo/a.ts');
    store.openContextFile('/repo', '/repo/b.ts');
    store.openContextSurface('/repo', 'terminal');
    const fileTab = useUIStore.getState().contextPanelByDirectory['/repo']!.tabs.find((tab) => tab.targetPath === '/repo/a.ts')!;
    store.setActiveContextPanelTab('/repo', fileTab.id);
    store.setContextPanelWidth('/repo', 'file', 520);
    store.toggleContextPanelExpanded('/repo');
  });
  const before = useUIStore.getState().contextPanelByDirectory['/repo']!;
  await click('contextPanel.actions.closePanel');
  await click('contextPanel.actions.openPanel');
  const after = useUIStore.getState().contextPanelByDirectory['/repo']!;
  expect(after.activeTabId).toBe(before.activeTabId);
  expect(after.tabs.map((tab) => tab.id)).toEqual(before.tabs.map((tab) => tab.id));
  expect(after.widthByMode.file).toBe(520);
  expect(after.expanded).toBe(true);
  expect(useUIStore.getState().isContextRailOpen).toBe(false);
});

it('keeps a different workspace’s last panel intact', async () => {
  await act(async () => {
    useUIStore.getState().openContextSurface('/other', 'git');
    useUIStore.getState().closeContextPanel('/other');
  });
  const other = useUIStore.getState().contextPanelByDirectory['/other'];
  await click('contextPanel.actions.openPanel');
  await click('contextPanel.actions.closePanel');
  expect(useUIStore.getState().contextPanelByDirectory['/other']).toBe(other);
  await act(async () => useUIStore.getState().toggleContextPanel('/other'));
  expect(useUIStore.getState().contextPanelByDirectory['/other']?.activeTabId).toBe('git');
});
