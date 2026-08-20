import { whenWorkbenchContext } from './context-keys';
import type { WorkbenchMenuItem } from './types';

const menus = new Map<string, WorkbenchMenuItem>();

export const registerWorkbenchMenuItem = (item: WorkbenchMenuItem): (() => void) => {
  menus.set(item.id, item);
  return () => {
    menus.delete(item.id);
  };
};

export const projectWorkbenchMenu = (group?: string): WorkbenchMenuItem[] => (
  [...menus.values()]
    .filter((item) => (group ? item.group === group : true))
    .filter((item) => !item.when || whenWorkbenchContext(item.when))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
);

export const resetWorkbenchMenus = (): void => {
  menus.clear();
};
