import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DESKTOP_EVENT_CHANNEL, IPC_CHANNELS } from "../src/shared/desktop-api.js";

const source = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("Electron security contract", () => {
  it("keeps the renderer sandboxed and denies ambient permissions", async () => {
    const main = await source("../src/main/main.ts");
    assert.match(main, /contextIsolation:\s*true/);
    assert.match(main, /nodeIntegration:\s*false/);
    assert.match(main, /sandbox:\s*true/);
    assert.match(main, /webSecurity:\s*true/);
    assert.match(main, /setPermissionRequestHandler[\s\S]*callback\(false\)/);
    assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
    assert.match(main, /requestSingleInstanceLock\(\)/);
  });

  it("exposes a narrow preload API without raw IPC primitives", async () => {
    const preload = await source("../src/preload/preload.ts");
    assert.match(preload, /contextBridge\.exposeInMainWorld\("piarium", api\)/);
    assert.doesNotMatch(preload, /ipcRenderer\.send\s*\(/);
    assert.doesNotMatch(preload, /exposeInMainWorld\([^,]+,\s*ipcRenderer/);
  });

  it("uses unique, namespaced IPC channels", () => {
    const channels = [...Object.values(IPC_CHANNELS), DESKTOP_EVENT_CHANNEL];
    assert.equal(new Set(channels).size, channels.length);
    assert.ok(channels.every((channel) => channel.startsWith("piarium:")));
  });
});
