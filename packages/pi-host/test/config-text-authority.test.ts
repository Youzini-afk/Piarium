import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createRequest,
  type EventEnvelope,
  type PiConfigTextAuthoritySnapshot,
  type ResponseEnvelope,
  type WireEnvelope,
} from "@piarium/protocol";
import { HostController } from "../src/host-controller.js";
import { MemoryHostTransport } from "../src/transport.js";

function isResponse(envelope: WireEnvelope, id: string): envelope is ResponseEnvelope {
  return envelope.kind === "response" && envelope.id === id;
}

function isEvent(envelope: WireEnvelope, event: string): envelope is EventEnvelope {
  return envelope.kind === "event" && envelope.event === event;
}

describe("resolved configuration text authorities", () => {
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
});
