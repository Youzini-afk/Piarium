import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, net, protocol, session } from "electron";
import { DESKTOP_EVENT_CHANNEL } from "../shared/desktop-api.js";
import { AppStore } from "./app-store.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { RuntimeBroker } from "./runtime-broker.js";

protocol.registerSchemesAsPrivileged([
  {
    privileges: {
      allowServiceWorkers: false,
      bypassCSP: false,
      corsEnabled: false,
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
    scheme: "piarium",
  },
]);
app.enableSandbox();
app.setAppUserModelId("io.piarium.desktop");

const isSmoke = process.argv.includes("--smoke") || process.env.PIARIUM_ELECTRON_SMOKE === "1";
const developmentUrl = process.env.PIARIUM_DEV_SERVER_URL;
if (isSmoke && process.env.PIARIUM_SMOKE_USER_DATA) {
  app.setPath("userData", resolve(process.env.PIARIUM_SMOKE_USER_DATA));
}
let mainWindow: BrowserWindow | undefined;
let broker: RuntimeBroker | undefined;
let removeIpcHandlers: (() => void) | undefined;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | undefined;

function resolveHostEntry(): string {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, "pi-host", "main.js")
    : resolve(app.getAppPath(), "..", "..", "packages", "pi-host", "dist", "main.js");
  if (!existsSync(candidate)) {
    throw new Error(`Pi host entry was not built: ${candidate}`);
  }
  return candidate;
}

function isAllowedNavigation(value: string): boolean {
  try {
    const url = new URL(value);
    if (developmentUrl) return url.origin === new URL(developmentUrl).origin;
    return url.protocol === "piarium:" && url.host === "app";
  } catch {
    return false;
  }
}

async function registerAppProtocol(): Promise<void> {
  const rendererRoot = resolve(app.getAppPath(), "dist", "renderer");
  protocol.handle("piarium", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Not found", { status: 404 });
    const requestedPath = decodeURIComponent(url.pathname).replace(/^[/\\]+/, "");
    const file = resolve(rendererRoot, requestedPath || "index.html");
    const relativePath = relative(rendererRoot, file);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

async function promptForProjectTrust(cwd: string) {
  const options = {
    buttons: ["信任并加载", "以安全模式继续"],
    cancelId: 1,
    checkboxLabel: "记住这个项目的决定",
    defaultId: 1,
    detail: `${cwd}\n\n项目内的 .pi 扩展、包和命令配置可能执行本机代码。只信任你了解来源的项目。`,
    message: "是否信任此项目的 Pi 资源？",
    noLink: true,
    type: "warning" as const,
  };
  const window = mainWindow;
  const result =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
  return { remember: result.checkboxChecked, trusted: result.response === 0 };
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    backgroundColor: "#11100f",
    height: 860,
    minHeight: 620,
    minWidth: 940,
    show: false,
    title: "Piarium",
    titleBarOverlay: {
      color: "#151311",
      height: 42,
      symbolColor: "#d9d1c7",
    },
    titleBarStyle: "hidden",
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      preload: join(app.getAppPath(), "dist", "main", "preload.cjs"),
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
    },
    width: 1440,
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => {
    if (!isSmoke) window.show();
  });
  if (developmentUrl) await window.loadURL(developmentUrl);
  else await window.loadURL("piarium://app/index.html");
  return window;
}

async function runSmoke(window: BrowserWindow): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "piarium-electron-smoke-"));
  try {
    const result = (await window.webContents.executeJavaScript(`(async () => {
      const info = await window.piarium.getAppInfo();
      const project = await window.piarium.openProject(${JSON.stringify(workspace)});
      const session = await window.piarium.createSession(project.path, "Electron smoke");
      const snapshot = await window.piarium.getSnapshot(session.sessionId);
      const entries = await window.piarium.getEntries(session.sessionId, true);
      await window.piarium.closeSession(session.sessionId);
      return {
        api: typeof window.piarium === "object",
        cwd: snapshot.cwd,
        entries: Array.isArray(entries),
        info,
        node: typeof process
      };
    })()`)) as {
      api?: unknown;
      cwd?: unknown;
      entries?: unknown;
      info?: { protocolVersion?: unknown };
      node?: unknown;
    };
    if (
      result.api !== true ||
      result.node !== "undefined" ||
      result.info?.protocolVersion !== 1 ||
      result.cwd !== workspace ||
      result.entries !== true
    ) {
      throw new Error(`Renderer isolation smoke failed: ${JSON.stringify(result)}`);
    }
    if (process.env.PIARIUM_CAPTURE_PATH) {
      const loaded = once(window.webContents, "did-finish-load");
      window.webContents.reload();
      await loaded;
      const ready = await window.webContents.executeJavaScript(`(async () => {
        const waitFor = async (selector) => {
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            const element = document.querySelector(selector);
            if (element) return element;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("Timed out waiting for " + selector);
        };
        const create = await waitFor(".project-home .button.primary");
        create.click();
        await waitFor(".composer");
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!document.querySelector(".composer")) {
          throw new Error("Composer did not remain mounted after session creation");
        }
        return true;
      })()`);
      if (ready !== true) throw new Error("Desktop capture journey did not reach the composer");
      window.showInactive();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      const image = await window.webContents.capturePage();
      await writeFile(resolve(process.env.PIARIUM_CAPTURE_PATH), image.toPNG());
    }
    process.stdout.write("PIARIUM_DESKTOP_SMOKE_OK\n");
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
  app.quit();
}

async function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    removeIpcHandlers?.();
    removeIpcHandlers = undefined;
    await broker?.dispose();
    broker = undefined;
    shutdownComplete = true;
  })();
  return shutdownPromise;
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  if (!developmentUrl) await registerAppProtocol();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  const store = new AppStore(join(app.getPath("userData"), "piarium.json"));
  await store.load();
  broker = new RuntimeBroker({
    emit: (event) => {
      const window = mainWindow;
      if (window && !window.isDestroyed()) window.webContents.send(DESKTOP_EVENT_CHANNEL, event);
    },
    hostEntry: resolveHostEntry(),
    promptForProjectTrust: (request) => promptForProjectTrust(request.cwd),
  });
  if (process.env.PIARIUM_DEBUG_HOST === "1") {
    broker.on("diagnostic", ({ level, message }) => {
      process.stderr.write(`[pi-host:${String(level)}] ${String(message)}\n`);
    });
  }
  removeIpcHandlers = registerIpcHandlers({
    broker,
    getWindow: () => mainWindow,
    store,
  });
  mainWindow = await createMainWindow();
  mainWindow.once("closed", () => {
    mainWindow = undefined;
  });
  if (isSmoke) await runSmoke(mainWindow);
}

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  void shutdown().finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
process.once("SIGINT", () => void shutdown().finally(() => app.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => app.exit(0)));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  bootstrap().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    if (!isSmoke) dialog.showErrorBox("Piarium 启动失败", message);
    app.exit(1);
  });
}
