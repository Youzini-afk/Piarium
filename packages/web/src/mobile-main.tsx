import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@piarium/application-client';
import '@piarium/ui/styles/application';
import '@piarium/ui/styles/fonts';

declare global {
  interface Window {
    __PIARIUM_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__PIARIUM_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@piarium/ui/apps/renderMobileApp')
  .then(({ renderMobileApp }) => {
    renderMobileApp(window.__PIARIUM_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
