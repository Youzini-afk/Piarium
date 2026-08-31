import type { RuntimeAPIs, TerminalAPI } from '@piarium/application-client';
import { createVSCodeFilesAPI } from './files';
import { createVSCodeSettingsAPI } from './settings';
import { createVSCodePermissionsAPI } from './permissions';
import { createVSCodeToolsAPI } from './tools';
import { createVSCodeEditorAPI } from './editor';
import { createVSCodeGitAPI } from './git';
import { createVSCodeActionsAPI } from './vscode';
import { createVSCodeGitHubAPI } from './github';
import { createVSCodeNotificationsAPI } from './notifications';
import { createVSCodeWorkspaceAPI } from './workspace';
import { createVSCodeDocumentsAPI } from './documents';
import { createVSCodeWorkspaceSearchAPI } from './workspace-search';
import { createVSCodeLanguageServicesAPI } from './language';
import {
  createVSCodeWorkspaceDebugAPI,
  createVSCodeWorkspaceTasksAPI,
  createVSCodeWorkspaceTestAPI,
} from './run';
import { createVSCodeExtensionsAPI } from './extensions';
import { createVSCodePiRuntimeAPI } from './piRuntime';

const terminalUnsupported = async (): Promise<never> => {
  throw new Error('Terminal is not supported in the VS Code runtime');
};

const createStubTerminalAPI = (): TerminalAPI => ({
  listShells: terminalUnsupported,
  createSession: terminalUnsupported,
  connect: (_sessionId, handlers) => {
    handlers.onError?.(new Error('Terminal is not supported in the VS Code runtime'), true);
    return { close: () => {} };
  },
  sendInput: terminalUnsupported,
  resize: terminalUnsupported,
  close: terminalUnsupported,
});

export const createVSCodeAPIs = (): RuntimeAPIs => ({
  runtime: { platform: 'vscode', isDesktop: false, isVSCode: true, label: 'VS Code Extension' },
  piRuntime: createVSCodePiRuntimeAPI(),
  terminal: createStubTerminalAPI(),
  git: createVSCodeGitAPI(),
  workspace: createVSCodeWorkspaceAPI(),
  files: createVSCodeFilesAPI(),
  documents: createVSCodeDocumentsAPI(),
  workspaceSearch: createVSCodeWorkspaceSearchAPI(),
  language: createVSCodeLanguageServicesAPI(),
  tasks: createVSCodeWorkspaceTasksAPI(),
  debug: createVSCodeWorkspaceDebugAPI(),
  tests: createVSCodeWorkspaceTestAPI(),
  settings: createVSCodeSettingsAPI(),
  permissions: createVSCodePermissionsAPI(),
  notifications: createVSCodeNotificationsAPI(),
  github: createVSCodeGitHubAPI(),
  extensions: createVSCodeExtensionsAPI(),
  tools: createVSCodeToolsAPI(),
  editor: createVSCodeEditorAPI(),
  vscode: createVSCodeActionsAPI(),
});
