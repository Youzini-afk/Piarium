import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_EVENT_CHANNEL,
  type DesktopApi,
  type DesktopEvent,
  IPC_CHANNELS,
} from "../shared/desktop-api.js";

const api: DesktopApi = {
  abort: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.abort, sessionId),
  chooseProject: () => ipcRenderer.invoke(IPC_CHANNELS.chooseProject),
  closeSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.closeSession, sessionId),
  createSession: (cwd, name) => ipcRenderer.invoke(IPC_CHANNELS.createSession, cwd, name),
  executeCommand: (sessionId, command) =>
    ipcRenderer.invoke(IPC_CHANNELS.executeCommand, sessionId, command),
  followUp: (sessionId, text, images) =>
    ipcRenderer.invoke(IPC_CHANNELS.followUp, sessionId, text, images),
  forkSession: (sessionId, entryId, position) =>
    ipcRenderer.invoke(IPC_CHANNELS.forkSession, sessionId, entryId, position),
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getEntries: (sessionId, branchOnly) =>
    ipcRenderer.invoke(IPC_CHANNELS.getEntries, sessionId, branchOnly),
  getRecentProjects: () => ipcRenderer.invoke(IPC_CHANNELS.getRecentProjects),
  getSettings: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.getSettings, sessionId),
  getSnapshot: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot, sessionId),
  installPackage: (sessionId, source) =>
    ipcRenderer.invoke(IPC_CHANNELS.installPackage, sessionId, source),
  listCommands: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.listCommands, sessionId),
  listModels: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.listModels, sessionId),
  listPackages: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.listPackages, sessionId),
  listProviders: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.listProviders, sessionId),
  listSessions: (cwd) => ipcRenderer.invoke(IPC_CHANNELS.listSessions, cwd),
  loginProvider: (sessionId, providerId, type) =>
    ipcRenderer.invoke(IPC_CHANNELS.loginProvider, sessionId, providerId, type),
  logoutProvider: (sessionId, providerId) =>
    ipcRenderer.invoke(IPC_CHANNELS.logoutProvider, sessionId, providerId),
  navigateSession: (sessionId, targetId, summarize) =>
    ipcRenderer.invoke(IPC_CHANNELS.navigateSession, sessionId, targetId, summarize),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: DesktopEvent) => listener(value);
    ipcRenderer.on(DESKTOP_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(DESKTOP_EVENT_CHANNEL, handler);
  },
  openProject: (path) => ipcRenderer.invoke(IPC_CHANNELS.openProject, path),
  openSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.openSession, input),
  prompt: (sessionId, text, images) =>
    ipcRenderer.invoke(IPC_CHANNELS.prompt, sessionId, text, images),
  removePackage: (sessionId, source) =>
    ipcRenderer.invoke(IPC_CHANNELS.removePackage, sessionId, source),
  respondToExtensionUi: (sessionId, response) =>
    ipcRenderer.invoke(IPC_CHANNELS.respondToExtensionUi, sessionId, response),
  selectModel: (sessionId, provider, modelId) =>
    ipcRenderer.invoke(IPC_CHANNELS.selectModel, sessionId, provider, modelId),
  steer: (sessionId, text, images) =>
    ipcRenderer.invoke(IPC_CHANNELS.steer, sessionId, text, images),
  updatePackages: (sessionId, source) =>
    ipcRenderer.invoke(IPC_CHANNELS.updatePackages, sessionId, source),
  updateSettings: (sessionId, patch) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateSettings, sessionId, patch),
};

contextBridge.exposeInMainWorld("piarium", api);
