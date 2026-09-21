import assert from "node:assert/strict";
import test from "node:test";
import {
  isVarinExtensionId,
  VARIN_CORE_SERVICE_VERSION,
  VARIN_DEBUG_SERVICE_ID,
  VARIN_LANGUAGE_SERVICE_ID,
  VARIN_TASKS_SERVICE_ID,
  VARIN_TEST_SERVICE_ID,
  VARIN_WORKSPACE_SEARCH_SERVICE_ID,
} from "../src/index.js";

test("core search and language service ids are versioned Varin extension ids", () => {
  assert.equal(VARIN_WORKSPACE_SEARCH_SERVICE_ID, "varin.workspace.search");
  assert.equal(VARIN_LANGUAGE_SERVICE_ID, "varin.language");
  assert.equal(VARIN_TASKS_SERVICE_ID, "varin.tasks");
  assert.equal(VARIN_DEBUG_SERVICE_ID, "varin.debug");
  assert.equal(VARIN_TEST_SERVICE_ID, "varin.test");
  assert.equal(VARIN_CORE_SERVICE_VERSION, 1);
  assert.equal(isVarinExtensionId(VARIN_WORKSPACE_SEARCH_SERVICE_ID), true);
  assert.equal(isVarinExtensionId(VARIN_LANGUAGE_SERVICE_ID), true);
});
