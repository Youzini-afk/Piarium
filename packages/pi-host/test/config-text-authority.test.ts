import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { describe, it } from "node:test";
import {
  createRequest,
  type EventEnvelope,
  PIARIUM_PROTOCOL_VERSION,
  type PiConfigTextAuthoritySnapshot,
  type ResponseEnvelope,
  type WireEnvelope,
} from "@piarium/protocol";
import { resolveAftUserConfigPath } from "../src/config-text-authority-resolver.js";
import { HostController } from "../src/host-controller.js";
import { MemoryHostTransport } from "../src/transport.js";

function isResponse(envelope: WireEnvelope, id: string): envelope is ResponseEnvelope {
  return envelope.kind === "response" && envelope.id === id;
}

function isEvent(envelope: WireEnvelope, event: string): envelope is EventEnvelope {
  return envelope.kind === "event" && envelope.event === event;
}

describe("resolved configuration text authorities", () => {
  it("matches AFT's absolute XDG and platform-specific home resolution", () => {
    assert.equal(
      resolveAftUserConfigPath({
        env: { HOME: "/home/fallback", XDG_CONFIG_HOME: "/srv/aft-config" },
        homedir: () => "/home/os",
        platform: "linux",
      }),
      "/srv/aft-config/cortexkit/aft.jsonc",
    );

    assert.equal(
      resolveAftUserConfigPath({
        env: {
          HOME: "D:\\home",
          USERPROFILE: "C:\\users\\profile",
          XDG_CONFIG_HOME: "relative-xdg",
        },
        homedir: () => "E:\\os-home",
        platform: "win32",
      }),
      "C:\\users\\profile\\.config\\cortexkit\\aft.jsonc",
    );
    assert.equal(
      resolveAftUserConfigPath({
        env: { HOME: "D:\\home" },
        homedir: () => "E:\\os-home",
        platform: "win32",
      }),
      "D:\\home\\.config\\cortexkit\\aft.jsonc",
    );
    assert.equal(
      resolveAftUserConfigPath({
        env: {},
        homedir: () => "E:\\os-home",
        platform: "win32",
      }),
      "E:\\os-home\\.config\\cortexkit\\aft.jsonc",
    );
    assert.equal(
      resolveAftUserConfigPath({
        env: { HOME: "relative-home" },
        homedir: () => "/home/os",
        platform: "linux",
      }),
      posix.resolve("relative-home/.config/cortexkit/aft.jsonc"),
    );
    assert.equal(
      resolveAftUserConfigPath({
        env: { XDG_CONFIG_HOME: "C:\\absolute-xdg" },
        homedir: () => "E:\\os-home",
        platform: "win32",
      }),
      win32.resolve("C:\\absolute-xdg\\cortexkit\\aft.jsonc"),
    );
  });

  it("resolves Pi Lens authorities, watches every project candidate, and enforces revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-config-authority-"));
    const workspace = join(root, "workspace");
    const cwd = join(workspace, "nested");
    const agentDir = join(root, "agent");
    const globalPath = join(root, "pi-lens-global.json");
    await mkdir(cwd, { recursive: true });
    await writeFile(globalPath, "{\"lens\":{\"enabled\":true}}\n", "utf8");

    const previousOverride = process.env.PI_LENS_CONFIG_PATH;
    process.env.PI_LENS_CONFIG_PATH = globalPath;
    const transport = new MemoryHostTransport();
    const controller = new HostController({
      agentDir,
      projectTrustOverride: true,
      transport,
    });
    controller.start();
    try {
      transport.receive(createRequest("create", "session.create", { cwd }));
      const created = await transport.waitFor((entry) => isResponse(entry, "create"));
      assert.ok(created.kind === "response" && created.ok);

      transport.receive(createRequest("global-get", "config.text.authority.get", {
        authority: "pi-lens-global",
      }));
      const globalResponse = await transport.waitFor((entry) => isResponse(entry, "global-get"));
      assert.ok(globalResponse.kind === "response" && globalResponse.ok);
      const globalSnapshot = globalResponse.result as PiConfigTextAuthoritySnapshot;
      assert.equal(globalSnapshot.authority, "pi-lens-global");
      assert.equal(globalSnapshot.content, "{\"lens\":{\"enabled\":true}}\n");
      assert.equal(globalSnapshot.exists, true);
      assert.equal(globalSnapshot.format, "json");
      assert.equal(globalSnapshot.path, globalPath);
      assert.equal(globalSnapshot.projectTrusted, true);

      transport.receive(createRequest("project-missing", "config.text.authority.get", {
        authority: "pi-lens-project",
      }));
      const missingResponse = await transport.waitFor((entry) =>
        isResponse(entry, "project-missing"),
      );
      assert.ok(missingResponse.kind === "response" && missingResponse.ok);
      const missingSnapshot = missingResponse.result as PiConfigTextAuthoritySnapshot;
      assert.equal(missingSnapshot.exists, false);
      assert.equal(missingSnapshot.path, join(cwd, ".pi-lens.json"));

      await writeFile(join(workspace, "pi-lens.json"), "{\"source\":\"plain\"}\n", "utf8");
      await writeFile(join(workspace, ".pi-lens.json"), "{\"source\":\"dot\"}\n", "utf8");
      transport.receive(createRequest("project-ancestor", "config.text.authority.get", {
        authority: "pi-lens-project",
      }));
      const ancestorResponse = await transport.waitFor((entry) =>
        isResponse(entry, "project-ancestor"),
      );
      assert.ok(ancestorResponse.kind === "response" && ancestorResponse.ok);
      const ancestorSnapshot = ancestorResponse.result as PiConfigTextAuthoritySnapshot;
      assert.equal(ancestorSnapshot.path, join(workspace, ".pi-lens.json"));
      assert.equal(ancestorSnapshot.content, "{\"source\":\"dot\"}\n");

      transport.receive(createRequest("project-watch", "config.watch", {
        target: { authority: "pi-lens-project", kind: "text-authority" },
      }));
      const watchResponse = await transport.waitFor((entry) => isResponse(entry, "project-watch"));
      assert.ok(watchResponse.kind === "response" && watchResponse.ok);
      const watchId = (watchResponse.result as { watchId: string }).watchId;
      await writeFile(join(cwd, "pi-lens.json"), "{\"source\":\"nearer\"}\n", "utf8");
      const changed = await transport.waitFor(
        (entry) =>
          isEvent(entry, "config.changed")
          && entry.event === "config.changed"
          && entry.data.watchId === watchId,
      );
      assert.ok(changed.kind === "event" && changed.event === "config.changed");
      assert.deepEqual(changed.data.target, {
        authority: "pi-lens-project",
        kind: "text-authority",
      });

      transport.receive(createRequest("project-nearer", "config.text.authority.get", {
        authority: "pi-lens-project",
      }));
      const nearerResponse = await transport.waitFor((entry) =>
        isResponse(entry, "project-nearer"),
      );
      assert.ok(nearerResponse.kind === "response" && nearerResponse.ok);
      const nearerSnapshot = nearerResponse.result as PiConfigTextAuthoritySnapshot;
      assert.equal(nearerSnapshot.path, join(cwd, "pi-lens.json"));

      const updatedContent = "{\n  \"source\": \"updated\"\n}\n";
      transport.receive(createRequest("project-update", "config.text.authority.update", {
        authority: "pi-lens-project",
        content: updatedContent,
        expectedRevision: nearerSnapshot.revision,
      }));
      const updateResponse = await transport.waitFor((entry) =>
        isResponse(entry, "project-update"),
      );
      assert.ok(updateResponse.kind === "response" && updateResponse.ok);
      const updatedSnapshot = updateResponse.result as PiConfigTextAuthoritySnapshot;
      assert.equal(await readFile(join(cwd, "pi-lens.json"), "utf8"), updatedContent);

      transport.receive(createRequest("project-jsonc", "config.text.authority.update", {
        authority: "pi-lens-project",
        content: "{\n  // JSONC is not accepted\n  \"source\": \"commented\"\n}\n",
        expectedRevision: updatedSnapshot.revision,
      }));
      const jsoncResponse = await transport.waitFor((entry) =>
        isResponse(entry, "project-jsonc"),
      );
      assert.ok(jsoncResponse.kind === "response" && !jsoncResponse.ok);
      assert.equal(jsoncResponse.error.code, "invalid_config_file");
      assert.equal(await readFile(join(cwd, "pi-lens.json"), "utf8"), updatedContent);

      transport.receive(createRequest("project-stale", "config.text.authority.update", {
        authority: "pi-lens-project",
        content: "{\"source\":\"stale\"}\n",
        expectedRevision: nearerSnapshot.revision,
      }));
      const staleResponse = await transport.waitFor((entry) =>
        isResponse(entry, "project-stale"),
      );
      assert.ok(staleResponse.kind === "response" && !staleResponse.ok);
      assert.equal(staleResponse.error.code, "config_conflict");

      await rm(join(cwd, "pi-lens.json"));
      await rm(join(workspace, ".pi-lens.json"));
      await rm(join(workspace, "pi-lens.json"));
      const linkedTarget = join(root, "linked-config-target");
      await mkdir(linkedTarget);
      await symlink(linkedTarget, join(cwd, ".pi-lens.json"), "junction");
      transport.receive(createRequest("project-symlink", "config.text.authority.get", {
        authority: "pi-lens-project",
      }));
      const symlinkResponse = await transport.waitFor((entry) =>
        isResponse(entry, "project-symlink"),
      );
      assert.ok(symlinkResponse.kind === "response" && !symlinkResponse.ok);
      assert.equal(symlinkResponse.error.code, "invalid_config_path");
    } finally {
      await controller.dispose();
      if (previousOverride === undefined) delete process.env.PI_LENS_CONFIG_PATH;
      else process.env.PI_LENS_CONFIG_PATH = previousOverride;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps the project authority behind the project trust gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-config-authority-trust-"));
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const transport = new MemoryHostTransport();
    const controller = new HostController({
      agentDir: join(root, "agent"),
      projectTrustOverride: false,
      transport,
    });
    controller.start();
    try {
      transport.receive(createRequest("create", "session.create", { cwd }));
      const created = await transport.waitFor((entry) => isResponse(entry, "create"));
      assert.ok(created.kind === "response" && created.ok);
      transport.receive(createRequest("project-get", "config.text.authority.get", {
        authority: "pi-lens-project",
      }));
      const denied = await transport.waitFor((entry) => isResponse(entry, "project-get"));
      assert.ok(denied.kind === "response" && !denied.ok);
      assert.equal(denied.error.code, "project_not_trusted");
    } finally {
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("owns the AFT user JSONC authority without project trust", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-aft-authority-"));
    const cwd = join(root, "workspace");
    const configHome = join(root, "config-home");
    const aftPath = join(configHome, "cortexkit", "aft.jsonc");
    await mkdir(cwd, { recursive: true });

    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    const transport = new MemoryHostTransport();
    const controller = new HostController({
      agentDir: join(root, "agent"),
      projectTrustOverride: false,
      transport,
    });
    controller.start();
    try {
      transport.receive(createRequest("aft-create", "session.create", { cwd }));
      const created = await transport.waitFor((entry) => isResponse(entry, "aft-create"));
      assert.ok(created.kind === "response" && created.ok);

      transport.receive(createRequest("aft-get", "config.text.authority.get", {
        authority: "aft-user",
      }));
      const getResponse = await transport.waitFor((entry) => isResponse(entry, "aft-get"));
      assert.ok(getResponse.kind === "response" && getResponse.ok);
      const missing = getResponse.result as PiConfigTextAuthoritySnapshot;
      assert.equal(missing.authority, "aft-user");
      assert.equal(missing.exists, false);
      assert.equal(missing.format, "jsonc");
      assert.equal(missing.path, aftPath);
      assert.equal(missing.projectTrusted, false);

      const content = "{\n  // AFT user preference\n  \"enabled\": true,\n}\n";
      transport.receive(createRequest("aft-update", "config.text.authority.update", {
        authority: "aft-user",
        content,
        expectedRevision: missing.revision,
      }));
      const updateResponse = await transport.waitFor((entry) => isResponse(entry, "aft-update"));
      assert.ok(updateResponse.kind === "response" && updateResponse.ok);
      const saved = updateResponse.result as PiConfigTextAuthoritySnapshot;
      assert.equal(saved.content, content);
      assert.equal(saved.format, "jsonc");
      assert.equal(await readFile(aftPath, "utf8"), content);

      transport.receive(createRequest("aft-watch", "config.watch", {
        target: { authority: "aft-user", kind: "text-authority" },
      }));
      const watchResponse = await transport.waitFor((entry) => isResponse(entry, "aft-watch"));
      assert.ok(watchResponse.kind === "response" && watchResponse.ok);
      const watchId = (watchResponse.result as { watchId: string }).watchId;

      const externalContent = "{\n  // External AFT change\n  \"enabled\": false,\n}\n";
      await writeFile(aftPath, externalContent, "utf8");
      const changed = await transport.waitFor(
        (entry) =>
          isEvent(entry, "config.changed")
          && entry.event === "config.changed"
          && entry.data.watchId === watchId,
      );
      assert.ok(changed.kind === "event" && changed.event === "config.changed");
      assert.deepEqual(changed.data.target, {
        authority: "aft-user",
        kind: "text-authority",
      });

      transport.receive(createRequest("aft-refresh", "config.text.authority.get", {
        authority: "aft-user",
      }));
      const refreshResponse = await transport.waitFor((entry) => isResponse(entry, "aft-refresh"));
      assert.ok(refreshResponse.kind === "response" && refreshResponse.ok);
      const refreshed = refreshResponse.result as PiConfigTextAuthoritySnapshot;
      assert.equal(refreshed.content, externalContent);
      assert.notEqual(refreshed.revision, saved.revision);

      transport.receive(createRequest("aft-stale", "config.text.authority.update", {
        authority: "aft-user",
        content,
        expectedRevision: saved.revision,
      }));
      const staleResponse = await transport.waitFor((entry) => isResponse(entry, "aft-stale"));
      assert.ok(staleResponse.kind === "response" && !staleResponse.ok);
      assert.equal(staleResponse.error.code, "config_conflict");
      assert.equal(await readFile(aftPath, "utf8"), externalContent);

      transport.receive({
        id: "aft-unknown",
        kind: "request",
        method: "config.text.authority.get",
        params: { authority: "unknown-authority" },
        v: PIARIUM_PROTOCOL_VERSION,
      } as unknown as WireEnvelope);
      const unknownResponse = await transport.waitFor((entry) => isResponse(entry, "aft-unknown"));
      assert.ok(unknownResponse.kind === "response" && !unknownResponse.ok);
      assert.equal(unknownResponse.error.code, "invalid_params");

      transport.receive(createRequest("aft-unwatch", "config.unwatch", { watchId }));
      const unwatchResponse = await transport.waitFor((entry) => isResponse(entry, "aft-unwatch"));
      assert.ok(unwatchResponse.kind === "response" && unwatchResponse.ok);

      await rm(aftPath);
      const linkedTarget = join(root, "linked-aft-target");
      await mkdir(linkedTarget);
      await symlink(linkedTarget, aftPath, "junction");
      transport.receive(createRequest("aft-symlink", "config.text.authority.get", {
        authority: "aft-user",
      }));
      const symlinkResponse = await transport.waitFor((entry) => isResponse(entry, "aft-symlink"));
      assert.ok(symlinkResponse.kind === "response" && !symlinkResponse.ok);
      assert.equal(symlinkResponse.error.code, "invalid_config_path");
    } finally {
      await controller.dispose();
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("owns the Hermes Memory JSON authority from the active agent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-hermes-authority-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "custom-agent");
    const configPath = join(agentDir, "hermes-memory-config.json");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const transport = new MemoryHostTransport();
    const controller = new HostController({
      agentDir,
      projectTrustOverride: false,
      transport,
    });
    controller.start();
    try {
      transport.receive(createRequest("hermes-create", "session.create", { cwd }));
      const created = await transport.waitFor((entry) => isResponse(entry, "hermes-create"));
      assert.ok(created.kind === "response" && created.ok);

      transport.receive(createRequest("hermes-get", "config.text.authority.get", {
        authority: "hermes-memory-user",
      }));
      const getResponse = await transport.waitFor((entry) => isResponse(entry, "hermes-get"));
      assert.ok(getResponse.kind === "response" && getResponse.ok);
      const missing = getResponse.result as PiConfigTextAuthoritySnapshot;
      assert.equal(missing.authority, "hermes-memory-user");
      assert.equal(missing.exists, false);
      assert.equal(missing.format, "json");
      assert.equal(missing.path, configPath);
      assert.equal(missing.projectTrusted, false);

      const content = "{\n  \"reviewEnabled\": true\n}\n";
      transport.receive(createRequest("hermes-update", "config.text.authority.update", {
        authority: "hermes-memory-user",
        content,
        expectedRevision: missing.revision,
      }));
      const updateResponse = await transport.waitFor((entry) => isResponse(entry, "hermes-update"));
      assert.ok(updateResponse.kind === "response" && updateResponse.ok);
      const saved = updateResponse.result as PiConfigTextAuthoritySnapshot;
      assert.equal(saved.content, content);
      assert.equal(saved.format, "json");
      assert.equal(await readFile(configPath, "utf8"), content);

      transport.receive(createRequest("hermes-jsonc", "config.text.authority.update", {
        authority: "hermes-memory-user",
        content: "{\n  // JSONC is not accepted\n  \"reviewEnabled\": false\n}\n",
        expectedRevision: saved.revision,
      }));
      const jsoncResponse = await transport.waitFor((entry) => isResponse(entry, "hermes-jsonc"));
      assert.ok(jsoncResponse.kind === "response" && !jsoncResponse.ok);
      assert.equal(jsoncResponse.error.code, "invalid_config_file");
      assert.equal(await readFile(configPath, "utf8"), content);

      transport.receive(createRequest("hermes-watch", "config.watch", {
        target: { authority: "hermes-memory-user", kind: "text-authority" },
      }));
      const watchResponse = await transport.waitFor((entry) => isResponse(entry, "hermes-watch"));
      assert.ok(watchResponse.kind === "response" && watchResponse.ok);
      const watchId = (watchResponse.result as { watchId: string }).watchId;

      const externalContent = "{\n  \"reviewEnabled\": false\n}\n";
      await writeFile(configPath, externalContent, "utf8");
      const changed = await transport.waitFor(
        (entry) =>
          isEvent(entry, "config.changed")
          && entry.event === "config.changed"
          && entry.data.watchId === watchId,
      );
      assert.ok(changed.kind === "event" && changed.event === "config.changed");
      assert.deepEqual(changed.data.target, {
        authority: "hermes-memory-user",
        kind: "text-authority",
      });

      transport.receive(createRequest("hermes-refresh", "config.text.authority.get", {
        authority: "hermes-memory-user",
      }));
      const refreshResponse = await transport.waitFor((entry) =>
        isResponse(entry, "hermes-refresh"),
      );
      assert.ok(refreshResponse.kind === "response" && refreshResponse.ok);
      const refreshed = refreshResponse.result as PiConfigTextAuthoritySnapshot;
      assert.equal(refreshed.content, externalContent);
      assert.notEqual(refreshed.revision, saved.revision);

      transport.receive(createRequest("hermes-stale", "config.text.authority.update", {
        authority: "hermes-memory-user",
        content,
        expectedRevision: saved.revision,
      }));
      const staleResponse = await transport.waitFor((entry) => isResponse(entry, "hermes-stale"));
      assert.ok(staleResponse.kind === "response" && !staleResponse.ok);
      assert.equal(staleResponse.error.code, "config_conflict");
      assert.equal(await readFile(configPath, "utf8"), externalContent);

      transport.receive(createRequest("hermes-unwatch", "config.unwatch", { watchId }));
      const unwatchResponse = await transport.waitFor((entry) =>
        isResponse(entry, "hermes-unwatch"),
      );
      assert.ok(unwatchResponse.kind === "response" && unwatchResponse.ok);

      await rm(configPath);
      const linkedTarget = join(root, "linked-hermes-target");
      await mkdir(linkedTarget);
      await symlink(linkedTarget, configPath, "junction");
      transport.receive(createRequest("hermes-symlink", "config.text.authority.get", {
        authority: "hermes-memory-user",
      }));
      const symlinkResponse = await transport.waitFor((entry) =>
        isResponse(entry, "hermes-symlink"),
      );
      assert.ok(symlinkResponse.kind === "response" && !symlinkResponse.ok);
      assert.equal(symlinkResponse.error.code, "invalid_config_path");
    } finally {
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
