import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/useUIStore';
import { ContextPanelMenu } from './ContextPanelMenu';

vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/useFeatureFlagsStore', () => ({ useFeatureFlagsStore: (select: (state: { planModeEnabled: boolean }) => unknown) => select({ planModeEnabled: false }) }));
vi.mock('@/stores/useGitStore', () => ({ useGitStatus: () => ({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/icons/DiffIcon', () => ({ DiffIcon: () => null }));
// Exercise the menu's actions against the real panel store; popup positioning belongs to Base UI.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button role="menuitem" onClick={onClick}>{children}</button>,
}));

let root: Root;
let container: HTMLElement;
beforeEach(async () => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<ContextPanelMenu />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const menuItem = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  .find((element) => element.textContent?.startsWith(label));
const click = async (label: string) => {
  const item = menuItem(label);
  expect(item).toBeDefined();
  await act(async () => item!.click());
};

it('opens and hides a view without discarding its tabs, width or selection', async () => {
  expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBeUndefined();
  expect(container.querySelectorAll('[aria-label="contextPanel.menu.open"]')).toHaveLength(1);
  await click('contextPanel.mode.files');
  await act(async () => {
    useUIStore.getState().openContextFile('/repo', '/repo/a.ts');
    useUIStore.getState().setContextPanelWidth('/repo', 'file', 520);
  });
  const before = useUIStore.getState().contextPanelByDirectory['/repo'];
  await click('contextPanel.actions.closePanel');
  expect(useUIStore.getState().contextPanelByDirectory['/repo']?.isOpen).toBe(false);
  await click('contextPanel.mode.files');
  const after = useUIStore.getState().contextPanelByDirectory['/repo'];
  expect(after?.isOpen).toBe(true);
  expect(after?.tabs.map(({ id, targetPath }) => ({ id, targetPath }))).toEqual(before?.tabs.map(({ id, targetPath }) => ({ id, targetPath })));
  expect(after?.activeTabId).toBe(before?.activeTabId);
  expect(after?.widthByMode.file).toBe(520);
});

it('keeps the selected view open instead of accidentally toggling it closed', async () => {
  await click('layout.rightSidebar.git');
  await click('layout.rightSidebar.git');
  const panel = useUIStore.getState().contextPanelByDirectory['/repo'];
  expect(panel?.isOpen).toBe(true);
  expect(panel?.tabs).toHaveLength(1);
  expect(menuItem('layout.rightSidebar.git')?.textContent).toContain('2');
});

it('offers content-driven views only when there is a retained tab to restore', async () => {
  expect(menuItem('contextPanel.mode.preview')).toBeUndefined();
  expect(menuItem('contextPanel.mode.plan')).toBeUndefined();
  await act(async () => {
    useUIStore.getState().openContextPreview('/repo', 'http://localhost:5173');
    useUIStore.getState().closeContextPanel('/repo');
  });
  await click('contextPanel.mode.preview');
  expect(useUIStore.getState().contextPanelByDirectory['/repo']?.isOpen).toBe(true);
});
