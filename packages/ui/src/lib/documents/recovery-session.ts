const STORAGE_KEY = 'varin.document-recovery.session';

export const getDocumentRecoverySessionId = (): string => {
  const created = crypto.randomUUID();
  if (typeof sessionStorage === 'undefined') return created;
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing && existing.length > 0) return existing;
    sessionStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return created;
  }
};
