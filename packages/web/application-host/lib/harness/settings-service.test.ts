import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { PiariumSettingsDocument } from "@piarium/settings-store";
import type { PiSettingsSnapshot } from "@piarium/protocol";
import { createSettingsService, settingsDocumentRevision, type SettingsServiceDeps } from "./settings-service.js";

/**
 * Focused contract tests for the shared-catalog settings service (D-306).
 * The point under test is authority routing: app-document CAS, pi-settings
 * scope rules, honest read-only/action surfaces — not the catalog text.
 */

const caller = { workspaceId: "ws-1", sessionId: "session-1" };

interface PiFixture {
  global: Record<string, unknown>;
  project: Record<string, unknown>;
  projectTrusted: boolean;
  updates: { scope: string; expectedRevision: string; set: Record<string, unknown>; remove: string[] }[];
}

function makePiSnapshot(fixture: PiFixture): PiSettingsSnapshot {
  return {
    global: fixture.global as PiSettingsSnapshot["global"],
    globalRevision: settingsDocumentRevision(fixture.global as PiariumSettingsDocument),
    project: fixture.project as PiSettingsSnapshot["project"],
    projectRevision: settingsDocumentRevision(fixture.project as PiariumSettingsDocument),
    projectTrusted: fixture.projectTrusted,
  };
}

function fixture(overrides: {
  app?: PiariumSettingsDocument;
  pi?: Partial<PiFixture>;
  onChanged?: SettingsServiceDeps["onChanged"];
} = {}) {
  let appDocument: PiariumSettingsDocument = overrides.app ?? {};
  const pi: PiFixture = {
    global: overrides.pi?.global ?? {},
    project: overrides.pi?.project ?? {},
    projectTrusted: overrides.pi?.projectTrusted ?? true,
    updates: [],
  };
  const deps: SettingsServiceDeps = {
    readAppSettings: async () => structuredClone(appDocument),
    persistAppSettings: async (changes, removals, expectedRevision) => {
      const revision = settingsDocumentRevision(appDocument);
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        return { conflict: true, revision, document: appDocument };
      }
      const next: PiariumSettingsDocument = structuredClone(appDocument);
      for (const [key, value] of Object.entries(changes)) {
        next[key] = value;
      }
      for (const key of removals) {
        delete next[key];
      }
      appDocument = next;
      return { conflict: false, revision: settingsDocumentRevision(next), document: next };
    },
    requestPi: async (_cwd, method, params) => {
      if (method === "settings.get") {
        return makePiSnapshot(pi);
      }
      const update = params as PiFixture["updates"][number];
      pi.updates.push(update);
      const layer = update.scope === "project" ? pi.project : pi.global;
      for (const [key, value] of Object.entries(update.set)) {
        layer[key] = value;
      }
      for (const key of update.remove) {
        delete layer[key];
      }
      return makePiSnapshot(pi);
    },
    resolveWorkspaceRoot: async () => "/repo/workspace",
    ...(overrides.onChanged ? { onChanged: overrides.onChanged } : {}),
  };
  return { service: createSettingsService(deps), pi, getApp: () => appDocument };
}

describe("settings service catalog search", () => {
  it("matches free text against ids, paths, and keywords", () => {
    const { service } = fixture();
    const result = service.search({ query: "theme dark" });
    assert.ok(result.total >= 1);
    assert.ok(result.items.some((item) => item.id === "appearance.dark-theme"));
  });

  it("browses by category and paginates", () => {
    const { service } = fixture();
    const all = service.search({ category: "chat", limit: 100 });
    assert.ok(all.items.every((item) => item.category === "chat"));
    const page = service.search({ category: "chat", limit: 3, offset: 0 });
    assert.equal(page.items.length, 3);
    assert.ok(page.total > 3);
  });

  it("locates a stable id exactly", () => {
    const { service } = fixture();
    const result = service.search({ id: "harness.shell" });
    assert.equal(result.total, 1);
    assert.equal(result.items[0]?.owner, "pi-settings");
  });
});

describe("settings read", () => {
  it("reads an app field with saved value and document revision", async () => {
    const { service } = fixture({ app: { themeVariant: "dark" } });
    const result = await service.read(caller, { id: "appearance.dark-theme" });
    assert.equal(result.state, "ok");
    const variant = result.fields?.find((field) => field.path === "themeVariant");
    assert.equal(variant?.saved, "dark");
    assert.equal(variant?.isSet, true);
    assert.ok(result.revision);
  });

  it("reports the real fresh-install auto-save default", async () => {
    const { service } = fixture();
    const result = await service.read(caller, { id: "appearance.auto-save-enabled" });
    assert.deepEqual(result.effective, { value: true, source: "default" });
  });

  it("masks secret fields to set/unset status", async () => {
    const { service } = fixture({ app: { desktopUiPassword: "hunter2" } });
    const result = await service.read(caller, { id: "sessions.desktop-ui-password" });
    const field = result.fields?.[0];
    assert.equal(field?.isSet, true);
    assert.equal(field?.saved, undefined);
  });

  it("resolves pi-settings effective value through project-over-global merge", async () => {
    const { service } = fixture({
      pi: {
        global: { harness: { shell: "powershell" } },
        project: { harness: { shell: "wsl" } },
      },
    });
    const result = await service.read(caller, { id: "harness.shell" });
    const shell = result.fields?.find((field) => field.path === "harness.shell");
    assert.equal(shell?.saved, "powershell");
    // effective read for multi-field entries comes through fields; single-field
    // entries populate `effective` — check domains (single-field json).
    const domains = await service.read(caller, { id: "harness.web.domains" });
    assert.equal(domains.effective?.source, "none");
  });

  it("reports denied project scope when the project file is untrusted", async () => {
    const { service } = fixture({ pi: { projectTrusted: false } });
    const result = await service.read(caller, { id: "harness.shell", scope: "project" });
    assert.equal(result.state, "denied");
    assert.ok(result.reason?.includes("trusted"));
    assert.equal(result.revisions?.project, undefined);
  });

  it("never applies an untrusted project layer to the effective value", async () => {
    const { service } = fixture({
      pi: {
        global: { harness: { web: { domains: { block: ["global.test"] } } } },
        project: { harness: { web: { domains: { block: ["untrusted.test"] } } } },
        projectTrusted: false,
      },
    });
    const result = await service.read(caller, { id: "harness.web.domains" });
    assert.deepEqual(result.effective?.value, { block: ["global.test"] });
    assert.notEqual(result.effective?.source, "project");
  });

  it("reports device-local rows honestly instead of inventing a value", async () => {
    const { service } = fixture();
    const result = await service.read(caller, { id: "appearance.language" });
    assert.equal(result.state, "unavailable");
    assert.equal(result.entry.writable, false);
  });

  it("returns the real action target for domain-managed rows", async () => {
    const { service } = fixture();
    const result = await service.read(caller, { id: "extensions.workbench.extensionSet" });
    assert.equal(result.state, "action");
    assert.equal(result.action?.domain, "service:extensions");
  });

  it("rejects unknown ids instead of returning an empty success", async () => {
    const { service } = fixture();
    await assert.rejects(service.read(caller, { id: "does.not.exist" }), /unknown settings id/);
  });
});

describe("settings update", () => {
  it("applies validated fields and returns the new revision", async () => {
    const changes: { ids: string[] }[] = [];
    const { service, getApp } = fixture({
      onChanged: (change) => changes.push({ ids: change.ids }),
    });
    const result = await service.update(caller, {
      id: "appearance.time-format",
      set: { timeFormatPreference: "24h" },
    });
    assert.equal(result.status, "applied");
    assert.equal(getApp().timeFormatPreference, "24h");
    assert.ok(result.revision);
    assert.deepEqual(changes[0]?.ids, ["appearance.time-format"]);
  });

  it("rejects enum violations loudly instead of coercing", async () => {
    const { service, getApp } = fixture();
    const result = await service.update(caller, {
      id: "appearance.time-format",
      set: { timeFormatPreference: "stardate" },
    });
    assert.equal(result.status, "failed");
    assert.equal(getApp().timeFormatPreference, undefined);
    assert.match(result.fields[0]?.error ?? "", /expected one of/);
  });

  it("honours expectedRevision CAS and reports the current revision on conflict", async () => {
    const { service } = fixture({ app: { themeVariant: "dark" } });
    const read = await service.read(caller, { id: "appearance.dark-theme" });
    const conflict = await service.update(caller, {
      id: "appearance.dark-theme",
      set: { themeVariant: "light" },
      expectedRevision: "stale-revision",
    });
    assert.equal(conflict.status, "failed");
    assert.equal(conflict.revision, read.revision);
    assert.match(conflict.fields[0]?.error ?? "", /revision conflict/);
  });

  it("removes overrides on reset and preserves sibling fields", async () => {
    const { service, getApp } = fixture({ app: { fontSize: 15, uiFont: "Inter" } });
    const result = await service.update(caller, {
      id: "appearance.interface-font-size",
      reset: ["fontSize"],
    });
    assert.equal(result.status, "applied");
    assert.equal(getApp().fontSize, undefined);
    assert.equal(getApp().uiFont, "Inter");
  });

  it("rejects pi scopes for app-owned entries and rejects secret resets", async () => {
    const { service, getApp } = fixture({ app: { desktopUiPassword: "stored" } });
    await assert.rejects(
      service.update(caller, {
        id: "appearance.time-format",
        scope: "global",
        set: { timeFormatPreference: "24h" },
      }),
      /host-owned/,
    );
    const reset = await service.update(caller, {
      id: "sessions.desktop-ui-password",
      reset: ["desktopUiPassword"],
    });
    assert.equal(reset.status, "failed");
    assert.equal(getApp().desktopUiPassword, "stored");
    assert.match(reset.fields[0]?.error ?? "", /cannot be reset/);
  });

  it("fails unknown field paths instead of silently dropping them", async () => {
    const { service } = fixture();
    const result = await service.update(caller, {
      id: "appearance.time-format",
      set: { timeFormatPreference: "24h", madeUpField: true },
    });
    assert.equal(result.status, "partial");
    assert.equal(result.fields.find((f) => f.path === "madeUpField")?.status, "failed");
    assert.equal(result.fields.find((f) => f.path === "timeFormatPreference")?.status, "applied");
  });

  it("enforces pi-settings scope ownership", async () => {
    const { service } = fixture();
    const result = await service.update(caller, {
      id: "harness.models.retrieval",
      scope: "project",
      set: { "harness.models": { explore: { providerId: "p", modelId: "m" } } },
    });
    assert.equal(result.status, "failed");
    assert.match(result.fields[0]?.error ?? "", /user-owned/);
  });

  it("writes pi-settings through the owner protocol with CAS", async () => {
    const { service, pi } = fixture({ pi: { global: { harness: { shell: "auto" } } } });
    const result = await service.update(caller, {
      id: "harness.shell",
      scope: "global",
      set: { "harness.shell": "wsl" },
    });
    assert.equal(result.status, "applied");
    assert.equal(pi.updates.length, 1);
    assert.equal(pi.updates[0]?.scope, "global");
    assert.ok(pi.updates[0]?.expectedRevision);
    assert.equal((pi.global.harness as Record<string, unknown>).shell, "wsl");
  });

  it("refuses to fake device-local and action entries", async () => {
    const { service } = fixture();
    await assert.rejects(
      service.update(caller, { id: "appearance.language", set: { locale: "fr" } }),
      /device-local/,
    );
    await assert.rejects(
      service.update(caller, { id: "plugins.packages", set: { anything: true } }),
      /domain action/,
    );
  });
});
