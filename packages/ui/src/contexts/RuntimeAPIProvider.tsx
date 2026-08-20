import React, { type JSX, type ReactNode } from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { bindDocumentRegistry } from '@/lib/documents/session';
import { bindLanguageServices } from '@/lib/language-services/session';
import { AgentEditorCoordinator } from '@/components/workbench/AgentEditorCoordinator';

export function RuntimeAPIProvider({ apis, children }: { apis: RuntimeAPIs; children: ReactNode }): JSX.Element {
  bindDocumentRegistry(apis.documents);
  bindLanguageServices(apis.language);
  return (
    <RuntimeAPIContext.Provider value={apis}>
      <AgentEditorCoordinator />
      {children}
    </RuntimeAPIContext.Provider>
  );
}
