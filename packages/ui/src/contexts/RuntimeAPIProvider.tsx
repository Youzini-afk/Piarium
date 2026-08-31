import React, { type JSX, type ReactNode } from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { bindDocumentRegistry } from '@/lib/documents/session';
import { bindLanguageServices } from '@/lib/language-services/session';
import { bindRunDebugServices } from '@/lib/run-debug/session';

export function RuntimeAPIProvider({ apis, children }: { apis: RuntimeAPIs; children: ReactNode }): JSX.Element {
  bindDocumentRegistry(apis.documents);
  bindLanguageServices(apis.language);
  bindRunDebugServices({ tasks: apis.tasks, debug: apis.debug, tests: apis.tests });
  return (
    <RuntimeAPIContext.Provider value={apis}>
      {children}
    </RuntimeAPIContext.Provider>
  );
}
