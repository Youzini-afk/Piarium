import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  packageSourceEnabled,
  setPackageSourceEnabled,
} from "../src/package-activation.js";

describe("Pi package activation", () => {
  it("disables and restores a plain package without changing its source", () => {
    const disabled = setPackageSourceEnabled("npm:example", false);
    assert.equal(packageSourceEnabled(disabled), false);
    assert.equal(setPackageSourceEnabled(disabled, true), "npm:example");
  });

  it("round-trips existing resource filters exactly", () => {
    const original = {
      source: "npm:filtered",
      extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
      skills: [],
      prompts: ["prompts/review.md"],
    };
    const disabled = setPackageSourceEnabled(original, false);

    assert.equal(packageSourceEnabled(disabled), false);
    assert.deepEqual(setPackageSourceEnabled(disabled, true), original);
  });

  it("temporarily shadows an autoload delta so the global package cannot remain active", () => {
    const original = {
      source: "npm:delta",
      autoload: false,
      extensions: ["+extensions/extra.ts"],
    };
    const disabled = setPackageSourceEnabled(original, false);

    assert.equal(typeof disabled === "object" && disabled.autoload, true);
    assert.deepEqual(setPackageSourceEnabled(disabled, true), original);
  });

  it("recognizes and enables a package disabled directly in native settings", () => {
    const disabled = {
      source: "npm:manual",
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    };

    assert.equal(packageSourceEnabled(disabled), false);
    assert.equal(setPackageSourceEnabled(disabled, true), "npm:manual");
  });
});
