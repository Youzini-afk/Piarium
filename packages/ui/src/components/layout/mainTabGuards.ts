import type { MainTab } from '@/stores/useUIStore';

export const shouldResetDesktopMainTabToChat = (tab: MainTab, isMobile: boolean): boolean => (
  !isMobile && tab !== 'chat' && tab !== 'terminal' && tab !== 'diagram'
);
