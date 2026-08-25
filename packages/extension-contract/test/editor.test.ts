import assert from "node:assert/strict";
import test from "node:test";
import {
  PIARIUM_EDITOR_MONACO_SERVICE_ID,
  PIARIUM_EDITOR_MONACO_SERVICE_VERSION,
  isPiariumExtensionId,
  type PiariumEditorDocumentController,
  type PiariumEditorMonacoServiceV1,
  type PiariumEditorMonacoStateResultV1,
  type PiariumEditorMonacoViewResultV1,
} from "../src/index.js";

test("public editor contracts stay framework-neutral and version the optional Monaco service", () => {
  assert.equal(PIARIUM_EDITOR_MONACO_SERVICE_ID, "piarium.editor.monaco");
  assert.equal(PIARIUM_EDITOR_MONACO_SERVICE_VERSION, 1);
  assert.equal(isPiariumExtensionId(PIARIUM_EDITOR_MONACO_SERVICE_ID), true);

  const controller = null as PiariumEditorDocumentController | null;
  const service = null as PiariumEditorMonacoServiceV1 | null;
  const activeView: PiariumEditorMonacoViewResultV1 = {
    status: "ready",
    view: {
      documentVersion: 4,
      focused: true,
      generation: 2,
      kind: "text",
      languageId: "typescript",
      providerId: "piarium.builtin.text",
      resource: { resourceId: "src/main.ts", workspaceId: "workspace" },
      selection: {
        start: { column: 1, line: 1 },
        end: { column: 4, line: 1 },
      },
      viewId: "view-1",
    },
  };
  const state: PiariumEditorMonacoStateResultV1 = {
    status: "ready",
    state: { activeViewId: "view-1", revision: 3, views: [activeView.view] },
  };
  assert.equal(controller, null);
  assert.equal(service, null);
  assert.deepEqual(structuredClone(activeView), activeView);
  assert.deepEqual(structuredClone(state), state);
});
