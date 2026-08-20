import type { DocumentsAPI } from '@/lib/api/types';
import { DocumentRegistry } from './registry';

let active: DocumentRegistry | null = null;
let bound: DocumentsAPI | null = null;
let lifecycleBound = false;

const flushRecovery = (): void => {
  void active?.flushRecoveryJournals();
};

const bindRecoveryLifecycle = (): void => {
  if (lifecycleBound || typeof window === 'undefined' || typeof document === 'undefined') return;
  lifecycleBound = true;
  window.addEventListener('pagehide', flushRecovery);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushRecovery();
  });
};

export const bindDocumentRegistry = (documents: DocumentsAPI): DocumentRegistry => {
  if (active && bound === documents) return active;
  active?.dispose();
  active = new DocumentRegistry({ documents });
  bound = documents;
  bindRecoveryLifecycle();
  return active;
};

export const getDocumentRegistry = (): DocumentRegistry => {
  if (!active) throw new Error('Document registry is not bound');
  return active;
};

export const resetDocumentRegistry = (): void => {
  active?.dispose();
  active = null;
  bound = null;
};
