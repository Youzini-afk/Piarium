import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@piarium/ui/lib/api/types';
import '@piarium/ui/index.css';
import '@piarium/ui/styles/fonts';

declare global {
  interface Window {
    __PIARIUM_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__PIARIUM_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@piarium/ui/apps/renderElectronMiniChatApp')
  .then(({ renderElectronMiniChatApp }) => {
    renderElectronMiniChatApp(window.__PIARIUM_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
