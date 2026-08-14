import assert from "node:assert/strict";
import test from "node:test";
import { SurfaceExtensionRuntime } from "@piarium/extension-surface";
import { runSurfaceExtensionConformance } from "../src/testing.js";

test("the author conformance harness proves contribution and service teardown", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const result = await runSurfaceExtensionConformance({
    activation: (context) => {
      context.contribute({
        contractVersion: 1,
        data: {},
        id: "dev.example.conformance.page",
        kind: "page",
        supports: ["web"],
      }, {});
      context.provide({ id: "dev.example.conformance.service", version: 1 }, {});
    },
    owner: {
      desiredRevision: 1,
      entrypointId: "main",
      extensionId: "dev.example.conformance",
      extensionVersion: "1.0.0",
      generation: 1,
      hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
      realmId: "conformance",
    },
    runtime,
  });
  assert.deepEqual(result.activeContributionIds, ["dev.example.conformance.page"]);
  assert.deepEqual(result.activeServiceIds, ["dev.example.conformance.service"]);
  assert.equal(runtime.getSnapshot().contributions.length, 0);
});
