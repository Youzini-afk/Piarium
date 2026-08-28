import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FOUNDATIONAL_PI_PACKAGE_IDS,
  FOUNDATIONAL_PI_PACKAGE_INTENTS,
  FOUNDATIONAL_PI_PACKAGE_MANIFEST,
  FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
  FOUNDATIONAL_PI_PACKAGE_OBSERVED_STATES,
  FOUNDATIONAL_PI_PACKAGE_OPERATION_STATES,
  FOUNDATIONAL_PI_PACKAGE_PROVENANCES,
  FOUNDATIONAL_PI_PACKAGE_STATUS_STATES,
  foundationalPackageIdentity,
  matchesFoundationalPackage,
  type FoundationalPiPackageStatusSnapshot,
} from "../src/index.js";

describe("foundational Pi package manifest", () => {
  it("publishes revision 2 with only the foundational runtime integrations", () => {
    assert.equal(FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION, 2);
    assert.equal(FOUNDATIONAL_PI_PACKAGE_MANIFEST.revision, 2);
    assert.deepEqual(FOUNDATIONAL_PI_PACKAGE_IDS, [
      "mcp",
      "permission-system",
    ]);

    const integrations = FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations;
    assert.equal(new Set(integrations.map((entry) => entry.id)).size, 2);
    assert.equal(new Set(integrations.map((entry) => entry.source)).size, 2);
    const aliases = integrations.flatMap((entry) => [...entry.packageAliases]);
    assert.equal(new Set(aliases).size, aliases.length);
    assert.ok(integrations.every((entry) => entry.introducedRevision === 1));
    assert.deepEqual(
      Object.fromEntries(integrations.map((entry) => [entry.id, entry.source])),
      {
        mcp: "npm:@piarium/pi-mcp-adapter",
        "permission-system": "npm:@gotgenes/pi-permission-system",
      },
    );
    assert.deepEqual(
      Object.fromEntries(integrations.map((entry) => [entry.id, entry.packageName])),
      {
        mcp: "@piarium/pi-mcp-adapter",
        "permission-system": "@gotgenes/pi-permission-system",
      },
    );
    assert.ok(
      integrations.every((entry) =>
        entry.packageAliases.some((alias) => alias === entry.packageName),
      ),
    );
    assert.ok(
      integrations
        .find((entry) => entry.id === "permission-system")
        ?.packageAliases.includes("pi-permission-system"),
    );
  });

  it("defines a browser-safe status snapshot across all independent state axes", () => {
    assert.deepEqual(FOUNDATIONAL_PI_PACKAGE_INTENTS, [
      "eligible",
      "suppressed",
      "policy_skipped",
    ]);
    assert.deepEqual(FOUNDATIONAL_PI_PACKAGE_PROVENANCES, ["none", "auto_managed", "adopted"]);
    assert.deepEqual(FOUNDATIONAL_PI_PACKAGE_OBSERVED_STATES, [
      "missing",
      "enabled",
      "disabled",
      "configured_broken",
      "incompatible",
      "source_conflict",
    ]);
    assert.deepEqual(FOUNDATIONAL_PI_PACKAGE_OPERATION_STATES, [
      "idle",
      "planned",
      "mutating",
      "verifying",
      "failed_retryable",
      "action_required",
    ]);
    assert.deepEqual(FOUNDATIONAL_PI_PACKAGE_STATUS_STATES, [
      "idle",
      "running",
      "ready",
      "degraded",
    ]);

    const snapshot: FoundationalPiPackageStatusSnapshot = {
      autoInstallNew: false,
      entries: [
        {
          error: "Configured package could not be loaded",
          id: "mcp",
          intent: "policy_skipped",
          observed: "source_conflict",
          operation: "action_required",
          provenance: "adopted",
          source: "npm:pi-mcp-adapter",
        },
      ],
      manifestRevision: 2,
      revision: 3,
      state: "degraded",
    };

    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  });

  it("matches scoped npm versions and Git basenames without replacing the observed source", () => {
    const permission = FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations[1];
    const mcp = FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations[0];
    assert.ok(permission);
    assert.ok(mcp);
    assert.equal(foundationalPackageIdentity("npm:@gotgenes/pi-permission-system@2.4.0"), "@gotgenes/pi-permission-system");
    assert.equal(foundationalPackageIdentity("git@github.com:fork/pi-mcp-adapter.git"), "pi-mcp-adapter");
    assert.equal(matchesFoundationalPackage(permission, {
      name: "@gotgenes/pi-permission-system",
      source: "npm:@gotgenes/pi-permission-system@2.4.0",
    }), true);
    assert.equal(matchesFoundationalPackage(mcp, {
      name: "pi-mcp-adapter",
      source: "https://github.com/example/pi-mcp-adapter.git",
    }), true);
    assert.equal(matchesFoundationalPackage(mcp, {
      name: "@piarium/pi-mcp-adapter",
      source: "npm:@piarium/pi-mcp-adapter@2.29.0-piarium.1",
    }), true);
  });
});
