import assert from "node:assert/strict"
import { test } from "node:test"

import {
  checkLastUpdated,
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

test("readStatusHeader extracts both header lines", () => {
  const header = readStatusHeader("# Title\n\nStatus: shipped\n\nLast updated: 2026-08-21\n")
  assert.deepEqual(header, { status: "shipped", lastUpdated: "2026-08-21" })
})

test("readStatusHeader reports missing headers as null", () => {
  assert.deepEqual(readStatusHeader("# Title\n\nBody.\n"), { status: null, lastUpdated: null })
})

test("checkLastUpdated ignores documents without the header", () => {
  const problem = checkLastUpdated({
    lastUpdated: null,
    today: "2026-08-21",
  })
  assert.equal(problem, null)
})

test("checkLastUpdated rejects a non-ISO date", () => {
  const problem = checkLastUpdated({
    lastUpdated: "Aug 21 2026",
    today: "2026-08-21",
  })
  assert.match(problem, /not an ISO/)
})

test("checkLastUpdated rejects a future date", () => {
  const problem = checkLastUpdated({
    lastUpdated: "2026-09-01",
    today: "2026-08-21",
  })
  assert.match(problem, /in the future/)
})

test("checkLastUpdated allows one day of timezone slack ahead of UTC", () => {
  const problem = checkLastUpdated({
    lastUpdated: "2026-08-22",
    today: "2026-08-21",
  })
  assert.equal(problem, null)
})

test("checkLastUpdated still rejects two days ahead of UTC", () => {
  const problem = checkLastUpdated({
    lastUpdated: "2026-08-23",
    today: "2026-08-21",
  })
  assert.match(problem, /in the future/)
})

test("checkLastUpdated crosses a month boundary when adding slack", () => {
  const problem = checkLastUpdated({
    lastUpdated: "2026-09-01",
    today: "2026-08-31",
  })
  assert.equal(problem, null)
})

test("checkLastUpdated does not compare against commit history", () => {
  const problem = checkLastUpdated({
    lastUpdated: "2026-08-14",
    today: "2026-08-21",
  })
  assert.equal(problem, null)
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
