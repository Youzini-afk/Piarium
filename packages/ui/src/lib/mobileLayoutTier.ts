import React from 'react';

import { useDeviceInfo, type DeviceType } from './device';

export type MobileLayoutTier =
  | 'phone-portrait'
  | 'phone-landscape'
  | 'tablet-portrait'
  | 'tablet-landscape';

export type MobileLayoutKind = 'phone' | 'tablet';

export interface MobileLayoutInfo {
  tier: MobileLayoutTier;
  kind: MobileLayoutKind;
  isPhone: boolean;
  isTablet: boolean;
  isPortrait: boolean;
  isLandscape: boolean;
  isTabletLandscape: boolean;
  prefersSidePanels: boolean;
  viewportWidth: number;
  viewportHeight: number;
}

export interface MobileLayoutInput {
  width: number;
  height: number;
  deviceType?: DeviceType;
  hasTouchInput?: boolean;
}

const TABLET_MIN_SHORT_EDGE = 700;
const TABLET_MIN_LONG_EDGE = 900;

const getWindowSizeSnapshot = () => {
  if (typeof window === 'undefined') {
    return { width: 390, height: 844 };
  }

  return {
    width: Math.max(1, Math.round(window.innerWidth || window.visualViewport?.width || 390)),
    height: Math.max(1, Math.round(window.innerHeight || window.visualViewport?.height || 844)),
  };
};

export const getMobileLayoutInfo = ({
  width,
  height,
  deviceType,
  hasTouchInput = true,
}: MobileLayoutInput): MobileLayoutInfo => {
  const viewportWidth = Math.max(1, Math.round(width));
  const viewportHeight = Math.max(1, Math.round(height));
  const shortEdge = Math.min(viewportWidth, viewportHeight);
  const longEdge = Math.max(viewportWidth, viewportHeight);
  const isLandscape = viewportWidth > viewportHeight;
  const isTablet =
    deviceType === 'tablet'
    || (hasTouchInput && shortEdge >= TABLET_MIN_SHORT_EDGE && longEdge >= TABLET_MIN_LONG_EDGE);
  const kind: MobileLayoutKind = isTablet ? 'tablet' : 'phone';
  const tier: MobileLayoutTier = isTablet
    ? isLandscape ? 'tablet-landscape' : 'tablet-portrait'
    : isLandscape ? 'phone-landscape' : 'phone-portrait';

  return {
    tier,
    kind,
    isPhone: kind === 'phone',
    isTablet,
    isPortrait: !isLandscape,
    isLandscape,
    isTabletLandscape: tier === 'tablet-landscape',
    prefersSidePanels: isTablet,
    viewportWidth,
    viewportHeight,
  };
};

export function useMobileLayoutInfo(): MobileLayoutInfo {
  const deviceInfo = useDeviceInfo();
  const [size, setSize] = React.useState(getWindowSizeSnapshot);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    let frameId: number | undefined;
    const update = () => {
      if (frameId !== undefined) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = undefined;
        setSize(getWindowSizeSnapshot());
      });
    };

    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    update();

    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      if (frameId !== undefined) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  return React.useMemo(
    () => getMobileLayoutInfo({
      width: size.width,
      height: size.height,
      deviceType: deviceInfo.deviceType,
      hasTouchInput: deviceInfo.hasTouchInput,
    }),
    [deviceInfo.deviceType, deviceInfo.hasTouchInput, size.height, size.width],
  );
}

export function useMobileLayoutRootAttributes(info: MobileLayoutInfo, enabled = true): void {
  React.useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;

    const root = document.documentElement;
    root.dataset.ocMobileLayoutTier = info.tier;
    root.dataset.ocMobileLayoutKind = info.kind;

    return () => {
      delete root.dataset.ocMobileLayoutTier;
      delete root.dataset.ocMobileLayoutKind;
    };
  }, [enabled, info.kind, info.tier]);
}
