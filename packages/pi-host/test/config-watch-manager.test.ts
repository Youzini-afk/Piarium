import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import type { PiConfigWatchChangeReason, PiConfigWatchSubscription } from "@piarium/protocol";
import { ConfigWatchManager } from "../src/config-watch-manager.js";

interface WatchEvent {
  reason: PiConfigWatchChangeReason;
  watchId: string;
}

async function waitForWatch(
  events: WatchEvent[],
  watchId: string,
  timeoutMs = 2_000,
): Promise<WatchEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = events.find((event) => event.watchId === watchId);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Configuration watch ${watchId} did not emit within ${timeoutMs}ms`);
}

describe("ConfigWatchManager", () => {
  it("emits after an atomic rename without closing the watcher from its callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-config-watch-atomic-"));
    const filePath = join(root, "native.json");
    const events: WatchEvent[] = [];
    const manager = new ConfigWatchManager((subscription, reason) => {
      events.push({ reason, watchId: subscription.watchId });
    });
    try {
      const subscription = await manager.watch(
        { kind: "document", path: "native.json", scope: "project" },
        [filePath],
      );
      const temporary = join(root, "native.json.atomic");
      await writeFile(temporary, "{\"external\":true}\n", "utf8");
      await rename(temporary, filePath);
      const event = await waitForWatch(events, subscription.watchId);
      assert.equal(event.reason, "rename");
    } finally {
      manager.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("matches Windows-insensitive filenames and stops after unwatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-config-watch-case-"));
    const filePath = join(root, "settings.json");
    const events: WatchEvent[] = [];
    const manager = new ConfigWatchManager((subscription, reason) => {
      events.push({ reason, watchId: subscription.watchId });
    });
    try {
      const subscription = await manager.watch(
        { kind: "settings", scope: "global" },
        [filePath],
      );
      const reportedName = process.platform === "win32"
        ? basename(filePath).toUpperCase()
        : basename(filePath);
      const temporary = join(root, `${reportedName}.atomic`);
      await writeFile(temporary, "{\"theme\":\"dark\"}\n", "utf8");
      await rename(temporary, join(root, reportedName));
      await waitForWatch(events, subscription.watchId);
      assert.equal(manager.unwatch(subscription.watchId), true);
      const count = events.filter((event) => event.watchId === subscription.watchId).length;
      const replacement = join(root, "settings.json.replacement");
      await writeFile(replacement, "{\"theme\":\"light\"}\n", "utf8");
      await rename(replacement, filePath);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(
        events.filter((event) => event.watchId === subscription.watchId).length,
        count,
      );
    } finally {
      manager.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rebinds after a missing parent directory appears", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-config-watch-nested-"));
    const nested = join(root, ".plugin", "native.jsonc");
    const events: WatchEvent[] = [];
    const manager = new ConfigWatchManager((subscription: PiConfigWatchSubscription, reason) => {
      events.push({ reason, watchId: subscription.watchId });
    });
    try {
      const subscription = await manager.watch(
        {
          format: "jsonc",
          kind: "text",
          path: ".plugin/native.jsonc",
          root: "project",
        },
        [nested],
      );
      await mkdir(join(root, ".plugin"));
      await writeFile(nested, "{\n  // external\n}\n", "utf8");
      await waitForWatch(events, subscription.watchId);
    } finally {
      manager.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
