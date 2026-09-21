import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  foundationalPackageIdentity,
  FOUNDATIONAL_PI_PACKAGE_MANIFEST,
  matchesFoundationalPackage,
} from "../src/index.js";

describe("foundational Pi package manifest", () => {
  it("matches scoped npm versions and Git basenames without replacing the observed source", () => {
    const mcp = FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations[0];
    assert.ok(mcp);
    assert.equal(foundationalPackageIdentity("git@github.com:fork/pi-mcp-adapter.git"), "pi-mcp-adapter");
    assert.equal(matchesFoundationalPackage(mcp, {
      name: "pi-mcp-adapter",
      source: "https://github.com/example/pi-mcp-adapter.git",
    }), true);
    assert.equal(matchesFoundationalPackage(mcp, {
      name: "@varin/pi-mcp-adapter",
      source: "npm:@varin/pi-mcp-adapter@2.29.0-varin.1",
    }), true);
  });
});
