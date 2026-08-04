import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainLayoutSource = readFileSync(
    join(__dirname, '..', 'MainLayout.tsx'),
    'utf-8',
);
const sessionSidebarSource = readFileSync(
    join(__dirname, '..', '..', 'pi-session', 'PiSessionSidebar.tsx'),
    'utf-8',
);

describe('MainLayout mobile PiSessionSidebar mount (issue #1695 regression guard)', () => {
    test('mobile PiSessionSidebar is not conditionally mounted on mobileLeftDrawerVisible', () => {
        const mobileSidebarIndex = mainLayoutSource.indexOf('<PiSessionSidebar mobileVariant');
        expect(mobileSidebarIndex).toBeGreaterThan(-1);

        const windowStart = Math.max(0, mobileSidebarIndex - 400);
        const precedingWindow = mainLayoutSource.slice(windowStart, mobileSidebarIndex);

        expect(/\{\s*mobileLeftDrawerVisible\s*&&\s*\(/.test(precedingWindow)).toBe(false);

        expect(precedingWindow.includes('pointer-events-none')).toBe(true);
        expect(mainLayoutSource.slice(mobileSidebarIndex, mobileSidebarIndex + 120)).toContain('isVisible={mobileLeftDrawerVisible}');
    });

    test('desktop PiSessionSidebar is rendered inside Sidebar without drawer-visibility gating', () => {
        const desktopSidebarIndex = mainLayoutSource.indexOf('<PiSessionSidebar isVisible={isSidebarOpen} />');
        expect(desktopSidebarIndex).toBeGreaterThan(-1);

        const windowStart = Math.max(0, desktopSidebarIndex - 300);
        const precedingWindow = mainLayoutSource.slice(windowStart, desktopSidebarIndex);

        expect(precedingWindow).toContain('<Sidebar');
        expect(/mobileLeftDrawerVisible\s*&&/.test(precedingWindow)).toBe(false);
    });

    test('the Pi sidebar exposes the shared settings surface from its fixed footer', () => {
        const scrollRegionIndex = sessionSidebarSource.indexOf('min-h-0 flex-1 overflow-y-auto');
        const footerIndex = sessionSidebarSource.indexOf('shrink-0 border-t border-border/60');

        expect(scrollRegionIndex).toBeGreaterThan(-1);
        expect(footerIndex).toBeGreaterThan(scrollRegionIndex);
        expect(sessionSidebarSource).toContain("t('sessions.sidebar.footer.actions.settings')");
        expect(sessionSidebarSource).toContain('if (mobileVariant) setSessionSwitcherOpen(false);');
        expect(sessionSidebarSource).toContain('setSettingsDialogOpen(true);');
    });
});
