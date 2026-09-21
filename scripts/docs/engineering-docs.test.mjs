import assert from "node:assert/strict"
import { test } from "node:test"

import {
  collectLocalLinkTargets,
  findOrphanDocs,
  readStatusHeader,
} from "./engineering-docs.mjs"

test("collectLocalLinkTargets returns inline local targets", () => {
  const targets = collectLocalLinkTargets("See [arch](architecture.md) and [rm](../README.md).")
  assert.deepEqual(targets, ["architecture.md", "../README.md"])
})

test("collectLocalLinkTargets skips external schemes and pure anchors", () => {
  const markdown = [
    "[site](https://example.com/a.md)",
    "[insecure](http://example.com)",
    "[mail](mailto:someone@example.com)",
    "[section](#heading)",
    "[real](docs/security.md)",
  ].join("\n")
  assert.deepEqual(collectLocalLinkTargets(markdown), ["docs/security.md"])
})

test("collectLocalLinkTargets strips fragments and decodes escapes", () => {
  const targets = collectLocalLinkTargets("[a](packages/electron/README.md#packaging) [b](a%20b.md)")
  assert.deepEqual(targets, ["packages/electron/README.md", "a b.md"])
})

test("collectLocalLinkTargets reads reference definitions", () => {
  assert.deepEqual(collectLocalLinkTargets("[ref]: docs/recovery.md\n"), ["docs/recovery.md"])
})

test("collectLocalLinkTargets ignores fenced code blocks", () => {
  const markdown = ["```md", "[fake](does-not-exist.md)", "```", "[real](exists.md)"].join("\n")
  assert.deepEqual(collectLocalLinkTargets(markdown), ["exists.md"])
})

test("readStatusHeader extracts delivery status", () => {
  assert.equal(readStatusHeader("# Title\n\nStatus: shipped\n"), "shipped")
})

test("readStatusHeader reports missing headers as null", () => {
  assert.equal(readStatusHeader("# Title\n\nBody.\n"), null)
})

test("findOrphanDocs flags documents nothing references", () => {
  const orphans = findOrphanDocs({
    candidates: ["docs/architecture.md", "docs/orphan-plan.md"],
    referencedPaths: new Set(["docs/architecture.md"]),
  })
  assert.deepEqual(orphans, ["docs/orphan-plan.md"])
})

test("findOrphanDocs honors an explicit allowlist", () => {
  const orphans = findOrphanDocs({
    candidates: ["docs/orphan-plan.md"],
    referencedPaths: new Set(),
    allowlist: { "docs/orphan-plan.md": "intentionally unindexed" },
  })
  assert.deepEqual(orphans, [])
})
