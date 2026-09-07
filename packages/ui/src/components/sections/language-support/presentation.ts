import type { PiariumLanguageProviderStatus, StructureGrammarStatus } from '@piarium/application-client';
import type { I18nKey } from '@/lib/i18n/store';

export type StatusTone = 'success' | 'warning' | 'danger' | 'muted';

export const languageServerStatusKey = (
  status: PiariumLanguageProviderStatus['status'],
): I18nKey => {
  switch (status) {
    case 'absent':
      return 'settings.languageSupport.lsp.absent';
    case 'starting':
      return 'settings.languageSupport.lsp.starting';
    case 'ready':
      return 'settings.languageSupport.lsp.ready';
    case 'degraded':
      return 'settings.languageSupport.lsp.degraded';
    case 'failed':
      return 'settings.languageSupport.lsp.failed';
  }
};

export const languageServerStatusTone = (
  status: PiariumLanguageProviderStatus['status'],
): StatusTone => {
  switch (status) {
    case 'ready':
      return 'success';
    case 'starting':
    case 'degraded':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'absent':
      return 'muted';
  }
};

export const grammarStatusKey = (status: StructureGrammarStatus): I18nKey => {
  switch (status) {
    case 'bundled':
      return 'settings.languageSupport.grammar.bundled';
    case 'installed':
      return 'settings.languageSupport.grammar.installed';
    case 'available':
      return 'settings.languageSupport.grammar.available';
    case 'absent':
      return 'settings.languageSupport.grammar.absent';
    case 'user-unverified':
      return 'settings.languageSupport.grammar.userUnverified';
  }
};

export const grammarStatusTone = (status: StructureGrammarStatus): StatusTone => {
  switch (status) {
    case 'bundled':
    case 'installed':
      return 'success';
    case 'available':
    case 'user-unverified':
      return 'warning';
    case 'absent':
      return 'muted';
  }
};

export const canInstallGrammar = (status: StructureGrammarStatus): boolean => status === 'available';

export const statusToneClass = (tone: StatusTone): string => {
  switch (tone) {
    case 'success':
      return 'text-[var(--status-success)]';
    case 'warning':
      return 'text-[var(--status-warning)]';
    case 'danger':
      return 'text-[var(--status-error)]';
    case 'muted':
      return 'text-muted-foreground';
  }
};
