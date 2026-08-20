import assert from "node:assert/strict";
import test from "node:test";
import {
  isPiariumExtensionId,
  PIARIUM_CORE_SERVICE_VERSION,
  PIARIUM_DEBUG_SERVICE_ID,
  PIARIUM_LANGUAGE_SERVICE_ID,
  PIARIUM_TASKS_SERVICE_ID,
  PIARIUM_TEST_SERVICE_ID,
  PIARIUM_WORKSPACE_SEARCH_SERVICE_ID,
} from "../src/index.js";

test("core search and language service ids are versioned Piarium extension ids", () => {
  assert.equal(PIARIUM_WORKSPACE_SEARCH_SERVICE_ID, "piarium.workspace.search");
  assert.equal(PIARIUM_LANGUAGE_SERVICE_ID, "piarium.language");
  assert.equal(PIARIUM_TASKS_SERVICE_ID, "piarium.tasks");
  assert.equal(PIARIUM_DEBUG_SERVICE_ID, "piarium.debug");
  assert.equal(PIARIUM_TEST_SERVICE_ID, "piarium.test");
  assert.equal(PIARIUM_CORE_SERVICE_VERSION, 1);
  assert.equal(isPiariumExtensionId(PIARIUM_WORKSPACE_SEARCH_SERVICE_ID), true);
  assert.equal(isPiariumExtensionId(PIARIUM_LANGUAGE_SERVICE_ID), true);
});
