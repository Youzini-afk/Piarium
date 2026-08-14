import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultPiariumWorkbenchProfileDocument,
  parsePiariumWorkbenchProfileDocument,
  resolvePiariumWorkbenchLayout,
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
