import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePiariumExtensionDiscoveryDocument } from "../src/index.js";

test("optional discovery catalogs preserve arbitrary accepted install sources without becoming an allowlist", () => {
  const document = parsePiariumExtensionDiscoveryDocument({
    schemaVersion: 1,
    entries: [{
      id: "dev.example.extension",
      displayName: "Example",
      keywords: ["workflow"],
      source: { display: "Example npm package", kind: "npm", specifier: "@example/piarium-extension" },
    }],
  });
  assert.equal(document.entries[0]?.source.specifier, "@example/piarium-extension");
  assert.throws(() => parsePiariumExtensionDiscoveryDocument({
    schemaVersion: 1,
    entries: [...document.entries, document.entries[0]],
  }), /unique/);
});

test("published manifest and discovery schemas are valid JSON documents", async () => {
  for (const name of ["piarium.extension.schema.json", "piarium.discovery-catalog.schema.json"]) {
    const path = fileURLToPath(new URL(`../schema/${name}`, import.meta.url));
    const schema = JSON.parse(await readFile(path, "utf8")) as { $schema?: unknown; type?: unknown };
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
  }
});
