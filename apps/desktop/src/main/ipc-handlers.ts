import { PIARIUM_PROTOCOL_VERSION } from "@piarium/protocol";
import {
  app,
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from "electron";
import { IPC_CHANNELS, type OpenSessionInput } from "../shared/desktop-api.js";
import { readImageAttachments, readJsonRecord, readJsonValue } from "../shared/ipc-validation.js";
import type { AppStore } from "./app-store.js";
import type { RuntimeBroker } from "./runtime-broker.js";

export interface IpcHandlerOptions {
  broker: RuntimeBroker;
  getWindow(): BrowserWindow | undefined;
  store: AppStore;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : expectString(value, label);
}

function assertSender(event: IpcMainInvokeEvent, window: BrowserWindow | undefined): void {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender.id !== window.webContents.id ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("Rejected IPC from an untrusted renderer");
  }
}

export function registerIpcHandlers(options: IpcHandlerOptions): () => void {
  const channels: string[] = [];
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => {
    channels.push(channel);
    ipcMain.handle(channel, (event, ...args) => {
      assertSender(event, options.getWindow());
      return listener(event, ...args);
    });
  };

  handle(IPC_CHANNELS.getAppInfo, async () => ({
    appVersion: app.getVersion(),
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    protocolVersion: PIARIUM_PROTOCOL_VERSION,
    runtimes: await options.broker.discoverRuntimes(),
  }));
  handle(IPC_CHANNELS.getRecentProjects, () => options.store.getRecentProjects());
  handle(IPC_CHANNELS.chooseProject, async () => {
    const parent = options.getWindow();
    const dialogOptions: OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      title: "选择 Piarium 项目目录",
    };
    const result =
      parent && !parent.isDestroyed()
        ? await dialog.showOpenDialog(parent, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    const path = result.filePaths[0];
    return result.canceled || !path ? null : options.store.openProject(path);
  });
  handle(IPC_CHANNELS.openProject, (_event, path) =>
    options.store.openProject(expectString(path, "path")),
  );
  handle(IPC_CHANNELS.listSessions, (_event, cwd) =>
    options.broker.listSessions(optionalString(cwd, "cwd")),
  );
  handle(IPC_CHANNELS.createSession, (_event, cwd, name) =>
    options.broker.createSession(expectString(cwd, "cwd"), optionalString(name, "name")),
  );
  handle(IPC_CHANNELS.openSession, (_event, rawInput) => {
    if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
      throw new TypeError("session input must be an object");
    }
    const input = rawInput as Record<string, unknown>;
    const parsed: OpenSessionInput = {
      ...(input.cwd === undefined ? {} : { cwd: expectString(input.cwd, "cwd") }),
      ...(input.sessionFile === undefined
        ? {}
        : { sessionFile: expectString(input.sessionFile, "sessionFile") }),
      ...(input.sessionId === undefined
        ? {}
        : { sessionId: expectString(input.sessionId, "sessionId") }),
    };
    return options.broker.openSession(parsed);
  });
  handle(IPC_CHANNELS.closeSession, (_event, sessionId) =>
    options.broker.closeSession(expectString(sessionId, "sessionId")),
  );
  handle(IPC_CHANNELS.getSnapshot, (_event, sessionId) => {
    const id = expectString(sessionId, "sessionId");
    return options.broker.requestForSession(id, "session.snapshot", { sessionId: id });
  });
  handle(IPC_CHANNELS.getEntries, (_event, sessionId, branchOnly) => {
    const id = expectString(sessionId, "sessionId");
    if (branchOnly !== undefined && typeof branchOnly !== "boolean") {
      throw new TypeError("branchOnly must be a boolean");
    }
    return options.broker.requestForSession(id, "session.entries", {
      ...(branchOnly === undefined ? {} : { branchOnly }),
      sessionId: id,
    });
  });
  handle(IPC_CHANNELS.forkSession, (_event, sessionId, entryId, position) => {
    if (position !== undefined && position !== "before" && position !== "at") {
      throw new TypeError("position must be before or at");
    }
    return options.broker.forkSession(
      expectString(sessionId, "sessionId"),
      expectString(entryId, "entryId"),
      position,
    );
  });
  handle(IPC_CHANNELS.navigateSession, (_event, sessionId, targetId, summarize) => {
    const id = expectString(sessionId, "sessionId");
    if (summarize !== undefined && typeof summarize !== "boolean") {
      throw new TypeError("summarize must be a boolean");
    }
    return options.broker.requestForSession(id, "session.navigate", {
      sessionId: id,
      ...(summarize === undefined ? {} : { summarize }),
      targetId: expectString(targetId, "targetId"),
    });
  });

  for (const [channel, method] of [
    [IPC_CHANNELS.prompt, "agent.prompt"],
    [IPC_CHANNELS.steer, "agent.steer"],
    [IPC_CHANNELS.followUp, "agent.followUp"],
  ] as const) {
    handle(channel, (_event, sessionId, text, images) => {
      const id = expectString(sessionId, "sessionId");
      const attachments = readImageAttachments(images);
      return options.broker.requestForSession(id, method, {
        ...(attachments === undefined ? {} : { images: attachments }),
        sessionId: id,
        text: expectString(text, "text"),
      });
    });
  }
  handle(IPC_CHANNELS.abort, (_event, sessionId) => {
    const id = expectString(sessionId, "sessionId");
    return options.broker.requestForSession(id, "agent.abort", { sessionId: id });
  });
  handle(IPC_CHANNELS.listCommands, (_event, sessionId) => {
    const id = expectString(sessionId, "sessionId");
    return options.broker.requestForSession(id, "command.list", { sessionId: id });
  });
  handle(IPC_CHANNELS.executeCommand, (_event, sessionId, command) => {
    const id = expectString(sessionId, "sessionId");
    return options.broker.requestForSession(id, "command.execute", {
      command: expectString(command, "command"),
      sessionId: id,
    });
  });
  handle(IPC_CHANNELS.listModels, (_event, sessionId) => {
    const id = expectString(sessionId, "sessionId");
    return options.broker.requestForSession(id, "model.list", {});
  });
  handle(IPC_CHANNELS.selectModel, (_event, sessionId, provider, modelId) => {
    const id = expectString(sessionId, "sessionId");
    return options.broker.requestForSession(id, "model.select", {
      modelId: expectString(modelId, "modelId"),
      provider: expectString(provider, "provider"),
      sessionId: id,
    });
  });
  handle(IPC_CHANNELS.listProviders, (_event, sessionId) => {
    const id = expectString(sessionId, "sessionId");
    return options.broker.requestForSession(id, "provider.list", {});
  });
  handle(IPC_CHANNELS.loginProvider, (_event, sessionId, providerId, type) => {
    const id = expectString(sessionId, "sessionId");
    if (type !== "api_key" && type !== "oauth") throw new TypeError("Invalid auth type");
    return options.broker.requestForSession(id, "provider.login", {
      providerId: expectString(providerId, "providerId"),
      type,
    });
  });
  handle(IPC_CHANNELS.logoutProvider, (_event, sessionId, providerId) => {
    const id = expectString(sessionId, "sessionId");
    return options.broker.requestForSession(id, "provider.logout", {
      providerId: expectString(providerId, "providerId"),
    });
  });
  handle(IPC_CHANNELS.getSettings, (_event, sessionId) => {
    const id = expectString(sessionId, "sessionId");
    return options.broker.requestForSession(id, "settings.get", {});
  });
  handle(IPC_CHANNELS.updateSettings, (_event, sessionId, patch) => {
    const id = expectString(sessionId, "sessionId");
    return options.broker.requestForSession(id, "settings.update", {
      patch: readJsonRecord(patch, "settings patch"),
    });
  });
  handle(IPC_CHANNELS.listPackages, (_event, sessionId) => {
    const id = expectString(sessionId, "sessionId");
    return options.broker.requestForSession(id, "package.list", {});
  });
  handle(IPC_CHANNELS.installPackage, async (_event, sessionId, source) => {
    const id = expectString(sessionId, "sessionId");
    const packageSource = expectString(source, "source");
    const parent = options.getWindow();
    const messageOptions: MessageBoxOptions = {
      buttons: ["安装并加载", "取消"],
      cancelId: 1,
      defaultId: 1,
      detail: `${packageSource}\n\nPi 扩展是可执行代码，并拥有当前用户权限。`,
      message: "确认安装 Pi 扩展？",
      noLink: true,
      type: "warning",
    };
    const confirmation =
      parent && !parent.isDestroyed()
        ? await dialog.showMessageBox(parent, messageOptions)
        : await dialog.showMessageBox(messageOptions);
    if (confirmation.response !== 0) throw new Error("Package installation cancelled");
    return options.broker.requestForSession(id, "package.install", { source: packageSource });
  });
  handle(IPC_CHANNELS.removePackage, async (_event, sessionId, source) => {
    const id = expectString(sessionId, "sessionId");
    const packageSource = expectString(source, "source");
    const parent = options.getWindow();
    const messageOptions: MessageBoxOptions = {
      buttons: ["移除", "取消"],
      cancelId: 1,
      defaultId: 1,
      detail: packageSource,
      message: "确认移除 Pi 扩展？",
      noLink: true,
      type: "warning",
    };
    const confirmation =
      parent && !parent.isDestroyed()
        ? await dialog.showMessageBox(parent, messageOptions)
        : await dialog.showMessageBox(messageOptions);
    if (confirmation.response !== 0) throw new Error("Package removal cancelled");
    return options.broker.requestForSession(id, "package.remove", { source: packageSource });
  });
  handle(IPC_CHANNELS.updatePackages, async (_event, sessionId, source) => {
    const id = expectString(sessionId, "sessionId");
    const packageSource = optionalString(source, "source");
    const parent = options.getWindow();
    const messageOptions: MessageBoxOptions = {
      buttons: ["更新并重新加载", "取消"],
      cancelId: 1,
      defaultId: 1,
      detail: packageSource ?? "更新所有已安装的 Pi 扩展",
      message: "确认更新 Pi 扩展？",
      noLink: true,
      type: "warning",
    };
    const confirmation =
      parent && !parent.isDestroyed()
        ? await dialog.showMessageBox(parent, messageOptions)
        : await dialog.showMessageBox(messageOptions);
    if (confirmation.response !== 0) throw new Error("Package update cancelled");
    return options.broker.requestForSession(id, "package.update", {
      ...(packageSource === undefined ? {} : { source: packageSource }),
    });
  });
  handle(IPC_CHANNELS.respondToExtensionUi, (_event, sessionId, response) => {
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      throw new TypeError("Extension UI response must be an object");
    }
    const parsed = readJsonRecord(response, "extension UI response");
    expectString(parsed.requestId, "requestId");
    if (parsed.cancelled !== undefined && typeof parsed.cancelled !== "boolean") {
      throw new TypeError("cancelled must be a boolean");
    }
    if (parsed.value !== undefined) readJsonValue(parsed.value, "extension UI response value");
    return options.broker.respondToExtensionUi(
      expectString(sessionId, "sessionId"),
      parsed as never,
    );
  });

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
