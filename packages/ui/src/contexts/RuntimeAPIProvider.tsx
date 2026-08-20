import React, { type JSX, type ReactNode } from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { bindDocumentRegistry } from '@/lib/documents/session';

export function RuntimeAPIProvider({ apis, children }: { apis: RuntimeAPIs; children: ReactNode }): JSX.Element {
  bindDocumentRegistry(apis.documents);
  return <RuntimeAPIContext.Provider value={apis}>{children}</RuntimeAPIContext.Provider>;
}
