import React from 'react';

import type { RuntimeAPIs } from '@/lib/api/types';
import { ApplicationLoadingScreen } from '@/components/ui/ApplicationLoadingScreen';

const App = React.lazy(async () => {
  const [appModule, extensionRuntime] = await Promise.all([
    import('@/App'),
    import('@/lib/extensions/managed-runtime'),
  ]);
  void extensionRuntime.startSurfaceExtensions().catch((error) => {
    console.error('[Piarium Extensions] Managed Surface startup failed:', error);
  });
  return { default: appModule.default };
});

export const PiariumApplication: React.FC<{ apis: RuntimeAPIs }> = ({ apis }) => (
  <React.Suspense fallback={<ApplicationLoadingScreen />}>
    <App apis={apis} />
  </React.Suspense>
);
