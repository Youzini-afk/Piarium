import { createConfiguredWebAPIs, getDesktopRelayRestoreReady } from './runtimeConfig';
import { registerSW } from 'virtual:pwa-register';

import type { RuntimeAPIs } from '@piarium/application-client';
import { getStoredMobileLayoutPreference } from '@piarium/ui/lib/mobileLayoutPreference';
import type { HostedSurface } from '@piarium/ui/lib/runtimeSurface';
import {
  isEmbeddedSessionChat,
  requestEmbeddedSessionRuntimeBootstrap,
} from '@piarium/ui/components/layout/contextPanelEmbeddedChat';
import '@piarium/ui/styles/application';
import '@piarium/ui/styles/fonts';

import { detectHostedSurface } from './hostedSurface';

declare global {
  interface Window {
    __PIARIUM_RUNTIME_APIS__?: RuntimeAPIs;
    __PIARIUM_SURFACE__?: HostedSurface;
  }
}

const isCoarsePointer = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia('(pointer: coarse)').matches;
};

const hostedSurface = detectHostedSurface({
  search: window.location.search,
  innerWidth: window.innerWidth || 0,
  screenWidth: window.screen?.width || window.innerWidth || 0,
  maxTouchPoints: navigator.maxTouchPoints || 0,
  isCoarsePointer: isCoarsePointer(),
  mobileLayoutPreference: getStoredMobileLayoutPreference(),
});
window.__PIARIUM_SURFACE__ = hostedSurface;

type PrerenderingDocument = Document & {
  prerendering?: boolean;
};

const canUseServiceWorker = (): boolean => {
  if (!('serviceWorker' in navigator)) return false;
  if (!window.isSecureContext) return false;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return false;

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    return false;
  }

  return true;
};

const runWhenDocumentCanRegisterServiceWorker = (task: () => void): void => {
  let completed = false;
  const run = () => {
    if (completed) return;
    if (canUseServiceWorker()) {
      completed = true;
      task();
    }
  };

  const afterLoad = () => {
    setTimeout(run, 0);
  };

  if (document.readyState === 'complete') {
    afterLoad();
  } else {
    window.addEventListener('load', afterLoad, { once: true });
  }

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    document.addEventListener('visibilitychange', run, { once: true });
  }
};

const registerPwaServiceWorker = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    try {
      registerSW({
        onRegisterError(error: unknown) {
          console.warn('[PWA] service worker registration skipped:', error);
        },
      });
    } catch (error) {
      console.warn('[PWA] service worker registration skipped:', error);
    }
  });
};

const unregisterDevelopmentServiceWorkers = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
  });
};

const start = async (): Promise<void> => {
  const embeddedBootstrap = isEmbeddedSessionChat()
    ? await requestEmbeddedSessionRuntimeBootstrap()
    : null;
  window.__PIARIUM_RUNTIME_APIS__ = createConfiguredWebAPIs(embeddedBootstrap);

  if (hostedSurface === 'mobile') {
    const { renderMobileApp } = await import('@piarium/ui/apps/renderMobileApp');
    renderMobileApp(window.__PIARIUM_RUNTIME_APIS__);
    void import('@piarium/ui/lib/extensions/managed-runtime').then(({ startSurfaceExtensions }) => (
      startSurfaceExtensions()
    )).catch((error) => {
      console.error('[Piarium Extensions] Managed Surface startup failed:', error);
    });
    return;
  }

  // Parse and compile the UI while the desktop relay transport is being
  // restored. Rendering still waits for the selected transport, so the auth
  // gate never probes a transient endpoint, but network/JS work no longer runs
  // serially behind a direct-address probe or relay handshake.
  const applicationModule = import('@piarium/ui/main');
  await Promise.all([getDesktopRelayRestoreReady(), applicationModule]);
};

void start();

if (import.meta.hot) {
  import.meta.hot.on('piarium:theme-updated', (theme: unknown) => {
    window.dispatchEvent(new CustomEvent('piarium:theme-hmr', { detail: theme }));
  });
}

if (import.meta.env.PROD) {
  registerPwaServiceWorker();
} else {
  unregisterDevelopmentServiceWorkers();
}
