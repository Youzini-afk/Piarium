import React from 'react';

import type { RuntimeAPIs } from '@/lib/api/types';
import { PiariumLogo } from '@/components/ui/PiariumLogo';

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

const ApplicationLoadingScreen: React.FC = () => (
  <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
    <PiariumLogo width={120} height={120} />
  </div>
);

export const PiariumApplication: React.FC<{ apis: RuntimeAPIs }> = ({ apis }) => (
  <React.Suspense fallback={<ApplicationLoadingScreen />}>
    <App apis={apis} />
  </React.Suspense>
);
