import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseVarinExtensionDiscoveryDocument } from "../src/index.js";

test("optional discovery catalogs preserve arbitrary accepted install sources without becoming an allowlist", () => {
  const document = parseVarinExtensionDiscoveryDocument({
    schemaVersion: 1,
    entries: [{
      id: "dev.example.extension",
      displayName: "Example",
      keywords: ["workflow"],
      source: { display: "Example npm package", kind: "npm", specifier: "@example/varin-extension" },
    }],
  });
  assert.equal(document.entries[0]?.source.specifier, "@example/varin-extension");
  assert.throws(() => parseVarinExtensionDiscoveryDocument({
    schemaVersion: 1,
    entries: [...document.entries, document.entries[0]],
  }), /unique/);
});

test("published manifest and discovery schemas are valid JSON documents", async () => {
  for (const name of ["varin.extension.schema.json", "varin.discovery-catalog.schema.json"]) {
    const path = fileURLToPath(new URL(`../schema/${name}`, import.meta.url));
    const schema = JSON.parse(await readFile(path, "utf8")) as { $schema?: unknown; type?: unknown };
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
  }
});
