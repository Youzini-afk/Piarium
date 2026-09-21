import assert from "node:assert/strict";
import test from "node:test";
import {
  VARIN_EDITOR_MONACO_SERVICE_ID,
  VARIN_EDITOR_MONACO_SERVICE_VERSION,
  isVarinExtensionId,
  type VarinEditorDocumentController,
  type VarinEditorMonacoServiceV1,
  type VarinEditorMonacoStateResultV1,
  type VarinEditorMonacoViewResultV1,
} from "../src/index.js";

test("public editor contracts stay framework-neutral and version the optional Monaco service", () => {
  assert.equal(VARIN_EDITOR_MONACO_SERVICE_ID, "varin.editor.monaco");
  assert.equal(VARIN_EDITOR_MONACO_SERVICE_VERSION, 1);
  assert.equal(isVarinExtensionId(VARIN_EDITOR_MONACO_SERVICE_ID), true);

  const controller = null as VarinEditorDocumentController | null;
  const service = null as VarinEditorMonacoServiceV1 | null;
  const activeView: VarinEditorMonacoViewResultV1 = {
    status: "ready",
    view: {
      documentVersion: 4,
      focused: true,
      generation: 2,
      kind: "text",
      languageId: "typescript",
      providerId: "varin.builtin.text",
      resource: { resourceId: "src/main.ts", workspaceId: "workspace" },
      selection: {
        start: { column: 1, line: 1 },
        end: { column: 4, line: 1 },
      },
      viewId: "view-1",
    },
  };
  const state: VarinEditorMonacoStateResultV1 = {
    status: "ready",
    state: { activeViewId: "view-1", revision: 3, views: [activeView.view] },
  };
  assert.equal(controller, null);
  assert.equal(service, null);
  assert.deepEqual(structuredClone(activeView), activeView);
  assert.deepEqual(structuredClone(state), state);
});
