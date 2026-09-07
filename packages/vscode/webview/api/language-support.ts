import type { LanguageSupportAPI, LanguageSupportInstallResult, LanguageSupportStatus } from '@piarium/application-client';

const unsupported = async (languageId: string): Promise<LanguageSupportInstallResult> => ({
  status: 'failed',
  languageId,
  reason: 'unsupported',
  message: 'Structure grammar packs are managed by the application host, not the VS Code companion.',
});

export const createVSCodeLanguageSupportAPI = (): LanguageSupportAPI => ({
  async getStatus(request): Promise<LanguageSupportStatus> {
    return {
      workspaceId: request.workspaceId,
      languages: [],
      partial: false,
      scannedFiles: 0,
      fileLimit: 0,
    };
  },
  install: ({ languageId }) => unsupported(languageId),
  cancelInstall: ({ languageId }) => unsupported(languageId),
  importUserGrammar: ({ languageId }) => unsupported(languageId),
});
