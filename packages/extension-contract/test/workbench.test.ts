import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultPiariumWorkbenchProfileDocument,
  inspectPiariumWorkbenchShell,
  parsePiariumWorkbenchLayoutLayer,
  parsePiariumWorkbenchProfileApplyRequest,
  parsePiariumWorkbenchProfileDocument,
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID,
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS,
  PIARIUM_WORKBENCH_SLOTS,
  resolvePiariumWorkbenchLayout,
  resolvePiariumWorkbenchLayoutForProfile,
  resolvePiariumWorkbenchProfile,
} from "../src/index.js";

test("workbench profile resolution layers distribution, user, and workspace without dropping missing references", () => {
  const document = defaultPiariumWorkbenchProfileDocument();
  document.layouts = [
    {
      profileId: "default",
      references: [{ contributionId: "dev.example.missing", region: "right", visible: true }],
      replacementSelections: { "workbench.shell": "dev.example.shell.base" },
      scope: "distribution",
      scopeId: "default",
      surface: "web",
    },
    {
      profileId: "default",
      references: [{ contributionId: "dev.example.missing", order: 20, visible: false }],
      replacementSelections: { "chat.composer": "dev.example.composer" },
      scope: "user",
      scopeId: "default",
      surface: "web",
    },
    {
      profileId: "default",
      references: [{ contributionId: "dev.example.panel", size: 360 }],
      replacementSelections: { "workbench.shell": "dev.example.shell.workspace" },
      scope: "workspace",
      scopeId: "/workspace",
      surface: "web",
    },
  ];
  const resolved = resolvePiariumWorkbenchLayout(parsePiariumWorkbenchProfileDocument(document), {
    surface: "web",
    userId: "default",
    workspaceId: "/workspace",
  });
  assert.deepEqual(resolved.replacementSelections, {
    "chat.composer": "dev.example.composer",
    "workbench.shell": "dev.example.shell.workspace",
  });
  assert.deepEqual(resolved.references, [
    { contributionId: "dev.example.missing", order: 20, region: "right", visible: false },
    { contributionId: "dev.example.panel", size: 360 },
  ]);
});

test("workbench profile documents reject duplicate layer and contribution identities", () => {
  const document = defaultPiariumWorkbenchProfileDocument();
  const layer = {
    profileId: "default",
    references: [
      { contributionId: "dev.example.panel" },
      { contributionId: "dev.example.panel" },
    ],
    replacementSelections: {},
    scope: "distribution",
    scopeId: "default",
    surface: "web",
  };
  document.layouts = [layer as never];
  assert.throws(() => parsePiariumWorkbenchProfileDocument(document), /duplicate contribution IDs/);
});

test("workbench profiles retain explicit extension sets and validate apply revisions", () => {
  const document = defaultPiariumWorkbenchProfileDocument();
  document.profiles[0] = {
    ...document.profiles[0]!,
    extensionIds: ["dev.example.alpha", "dev.example.beta"],
  };
  const parsed = parsePiariumWorkbenchProfileDocument(document);
  assert.deepEqual(parsed.profiles[0]?.extensionIds, ["dev.example.alpha", "dev.example.beta"]);
  assert.deepEqual(parsePiariumWorkbenchProfileApplyRequest({
    expectedCatalogRevision: 7,
    profileId: "default",
  }), {
    expectedCatalogRevision: 7,
    profileId: "default",
  });
  assert.throws(
    () => parsePiariumWorkbenchProfileDocument({
      ...document,
      profiles: [{ ...document.profiles[0], extensionIds: ["dev.example.alpha", "dev.example.alpha"] }],
    }),
    /duplicates/,
  );
});

const catalogEntry = (options: {
  enabled: boolean;
  failed?: boolean;
  contributionId: string;
  extensionId: string;
  supports?: Array<"desktop" | "mobile" | "vscode" | "web">;
}) => ({
  actual: options.failed
    ? [{
      desiredRevision: 1,
      diagnostics: [],
      entrypointId: "main",
      generation: 1,
      hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
      realmId: "surface",
      realmKind: "surface" as const,
      status: "failed" as const,
      updatedAt: "2026-08-20T00:00:00.000Z",
    }]
    : [],
  capabilityGrants: [],
  desired: { enabled: options.enabled, revision: 1, updatedAt: "2026-08-20T00:00:00.000Z" },
  installedAt: "2026-08-20T00:00:00.000Z",
  manifest: {
    engines: { piarium: "*" },
    id: options.extensionId,
    schemaVersion: 1 as const,
    version: "1.0.0",
    contributions: [{
      contractVersion: 1,
      data: {},
      id: options.contributionId,
      kind: "shell" as const,
      supports: options.supports ?? ["web", "desktop"],
    }],
  },
  resolvedVersion: "1.0.0",
  selectedVersion: "1.0.0",
  source: { display: options.extensionId, kind: "local" as const },
  updatedAt: "2026-08-20T00:00:00.000Z",
});

test("workbench slot and replacement target constants are valid contribution IDs", () => {
  for (const id of [...Object.values(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS), ...Object.values(PIARIUM_WORKBENCH_SLOTS)]) {
    parsePiariumWorkbenchLayoutLayer({
      profileId: PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID,
      references: [{ contributionId: id }],
      replacementSelections: { [id]: id },
      scope: "distribution",
      scopeId: PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID,
      surface: "web",
    });
  }
});

test("workbench profile resolution inspects shell availability without mutating enablement", () => {
  const document = defaultPiariumWorkbenchProfileDocument();
  document.profiles.push({ id: "studio", label: "Studio" });
  document.layouts = [{
    profileId: "studio",
    references: [],
    replacementSelections: { [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: "dev.example.shell" },
    scope: "distribution",
    scopeId: "studio",
    surface: "web",
  }];
  const context = { surface: "web" as const, userId: "default" };
  const original = structuredClone(document);
  const builtin = resolvePiariumWorkbenchProfile(document, [], context);
  assert.equal(builtin.status, "builtin");
  assert.equal(builtin.profileId, PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID);

  const candidate = resolvePiariumWorkbenchLayoutForProfile(document, context, "studio");
  assert.equal(candidate.replacementSelections[PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell], "dev.example.shell");
  assert.deepEqual(document, original);

  const extensions = [catalogEntry({
    enabled: false,
    contributionId: "dev.example.shell",
    extensionId: "dev.example.workbench",
  })];
  assert.equal(inspectPiariumWorkbenchShell(candidate.replacementSelections, extensions, "web").status, "disabled");
  assert.equal(extensions[0]?.desired.enabled, false);

  document.profileSelections.users.default = "studio";
  const disabled = resolvePiariumWorkbenchProfile(document, extensions, context);
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.shellExtensionId, "dev.example.workbench");

  extensions[0]!.desired.enabled = true;
  assert.equal(resolvePiariumWorkbenchProfile(document, extensions, context).status, "ready");
  extensions[0]!.actual = catalogEntry({
    enabled: true,
    failed: true,
    contributionId: "dev.example.shell",
    extensionId: "dev.example.workbench",
  }).actual;
  assert.equal(resolvePiariumWorkbenchProfile(document, extensions, context).status, "failed");
  assert.equal(resolvePiariumWorkbenchProfile(document, [], context).status, "missing");
});
