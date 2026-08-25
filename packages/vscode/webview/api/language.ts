import type {
  LanguageServicesAPI,
  PiariumLanguageFeatureResult,
  PiariumLanguageProviderStatus,
} from '@piarium/ui/lib/api/types';

const absentStatus = (workspaceId: string, languageId: string): PiariumLanguageProviderStatus => ({
  status: 'absent',
  workspaceId,
  languageId,
});

const absentFeature = async <T>(): Promise<PiariumLanguageFeatureResult<T>> => (
  { status: 'absent' }
);

export const createVSCodeLanguageServicesAPI = (): LanguageServicesAPI => ({
  getStatus: async (workspaceId, languageId) => absentStatus(workspaceId, languageId),
  subscribe() {
    return { close() {} };
  },
  syncDocument: async () => ({ status: 'absent' }),
  completion: absentFeature,
  completionResolve: absentFeature,
  hover: absentFeature,
  signatureHelp: absentFeature,
  definition: absentFeature,
  references: absentFeature,
  documentSymbols: absentFeature,
  workspaceSymbols: absentFeature,
  rename: absentFeature,
  codeActions: absentFeature,
  codeActionResolve: absentFeature,
  executeCommand: absentFeature,
  documentFormatting: absentFeature,
  documentRangeFormatting: absentFeature,
  onTypeFormatting: absentFeature,
  semanticTokens: absentFeature,
  inlayHints: absentFeature,
  inlayHintResolve: absentFeature,
  documentHighlights: absentFeature,
  foldingRanges: absentFeature,
  selectionRanges: absentFeature,
  documentLinks: absentFeature,
  documentLinkResolve: absentFeature,
  documentColors: absentFeature,
  colorPresentations: absentFeature,
  restart: async (workspaceId, languageId) => absentStatus(workspaceId, languageId),
  disposeWorkspace: async () => {},
});
