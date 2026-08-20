import React from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { MobileWorkspaceShell } from '@/apps/mobileWorkspaceShell';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { piariumSurfaceRuntime } from './surface-runtime';

export const MOBILE_WORKSPACE_DISCONNECTED_EVENT = 'piarium:mobile-workspace-disconnected';

export const AgentWorkspaceShell: React.FC<Record<string, unknown>> = () => {
  if (piariumSurfaceRuntime.surface === 'mobile') {
    return (
      <MobileWorkspaceShell
        onActiveConnectionDeleted={() => {
          switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
          window.dispatchEvent(new Event(MOBILE_WORKSPACE_DISCONNECTED_EVENT));
        }}
      />
    );
  }
  return <MainLayout />;
};
