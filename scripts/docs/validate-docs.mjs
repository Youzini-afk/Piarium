import { execFile } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import {
  REQUIRED_STATUS_HEADER_DOCS,
  checkLastUpdated,
  collectLocalLinkTargets,
  findOrphanDocs,
  readStatusHeader,
} from "./engineering-docs.mjs"

const execFileAsync = promisify(execFile)

const repoRoot = path.resolve(import.meta.dirname, "..", "..")
const docsRoot = path.join(repoRoot, "packages", "docs")
const contentRoot = path.join(docsRoot, "content", "docs")
const sidebarPath = path.join(docsRoot, "sidebar.config.json")

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(target)
      return [target]
    }),
  )
  return files.flat()
}

function toPosix(value) {
  return value.split(path.sep).join("/")
}

function routeFromFile(filePath) {
  const relative = toPosix(path.relative(contentRoot, filePath))
  const withoutExt = relative.replace(/\.mdx$/, "")

  if (withoutExt === "index") return "/"
  if (withoutExt.endsWith("/index")) {
    return `/${withoutExt.slice(0, -"/index".length)}/`
  }

  return `/${withoutExt}/`
}

function hasFrontmatterKey(content, key) {
  const hit = /^---\n([\s\S]*?)\n---\n/m.exec(content)
  if (!hit) return false
  return new RegExp(`^${key}:\\s*.+$`, "m").test(hit[1])
}

async function git(args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot })
    return stdout
  } catch {
    return null
  }
}

/**
 * Engineering docs are the repo-level contracts, not the user-facing docs site.
 *
 * The README translations live in `.github/readme/` rather than the repository root, which GitHub
 * would otherwise list five near-identical files in. They are covered here so a new language is
 * validated the day it is added rather than the day someone notices its links rotted, and because
 * their links are all two levels relative and therefore the easiest kind to get wrong.
 */
async function engineeringDocPaths() {
  const tracked = await git([
    "ls-files", "--", "AGENTS.md", "README.md", ".github/readme", "docs",
  ])
  if (tracked === null) return null
  return tracked
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".md"))
}

async function exists(absolutePath) {
  try {
    await stat(absolutePath)
    return true
  } catch {
    return false
  }
}

/**
 * Validate the engineering docs: link integrity, honest status headers, and no orphaned documents.
 * Skipped with a notice when git is unavailable, since file discovery and dates both depend on it.
 */
async function validateEngineeringDocs(errors) {
  const files = await engineeringDocPaths()
  if (files === null || files.length === 0) {
    console.log("Engineering docs validation skipped: git file listing unavailable.")
    return { checked: 0, links: 0 }
  }

  const modified = new Set(
    (await git(["diff", "--name-only", "HEAD"]) ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  )
  const today = new Date().toISOString().slice(0, 10)

  // A shallow clone has no per-file history: git reports the single fetched commit for every path,
  // which would fail every document whose header predates it. Skip the date comparison instead of
  // reporting dates we cannot actually determine.
  const shallow = (await git(["rev-parse", "--is-shallow-repository"]))?.trim() === "true"
  if (shallow) {
    console.log("Engineering docs: 'Last updated' comparison skipped on a shallow clone.")
  }

  const referencedPaths = new Set()
  let linkCount = 0

  for (const file of files) {
    const body = await readFile(path.join(repoRoot, file), "utf8")
    const fileDir = path.posix.dirname(file)

    for (const target of collectLocalLinkTargets(body)) {
      linkCount += 1
      const resolved = path.posix.normalize(path.posix.join(fileDir, target))
      if (!(await exists(path.join(repoRoot, resolved)))) {
        errors.push(`${file}: link target does not exist: ${target}`)
        continue
      }
      // A self-link must not let a document vouch for its own reachability.
      if (resolved !== file) referencedPaths.add(resolved)
    }

    const { status, lastUpdated } = readStatusHeader(body)
    if (REQUIRED_STATUS_HEADER_DOCS.includes(file)) {
      if (status === null) errors.push(`${file}: missing a 'Status:' header line`)
      if (lastUpdated === null) errors.push(`${file}: missing a 'Last updated:' header line`)
    }

    const lastCommitDate = shallow
      ? null
      : (await git(["log", "-1", "--format=%ad", "--date=short", "--", file]))?.trim() || null

    const problem = checkLastUpdated({
      lastUpdated,
      lastCommitDate,
      hasUncommittedChanges: modified.has(file),
      today,
    })
    if (problem) errors.push(`${file}: ${problem}`)
  }

  // A document nothing links to cannot be noticed when it goes stale. `docs/` is the index surface,
  // so only require inbound references there; READMEs and AGENTS.md are entry points by definition.
  const candidates = files.filter((file) => file.startsWith("docs/"))
  const reachable = new Set(referencedPaths)
  for (const extra of await extraReferenceSources()) reachable.add(extra)

  for (const orphan of findOrphanDocs({ candidates, referencedPaths: reachable })) {
    errors.push(
      `${orphan}: no other document, page, or source file links to it. `
      + "Link it from docs/roadmap.md, docs/architecture.md, or a README so it cannot drift unnoticed.",
    )
  }

  return { checked: files.length, links: linkCount }
}

/**
 * Reference targets from outside the engineering docs: the docs site and GitHub-maintained metadata
 * can also legitimately anchor a document.
 */
async function extraReferenceSources() {
  const listed = await git(["ls-files", "packages/docs", ".github"])
  if (listed === null) return []
  const paths = listed.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  const referenced = new Set()

  for (const file of paths) {
    if (!/\.(md|mdx|json|ts|tsx|js|mjs|yml|yaml)$/.test(file)) continue
    const body = await readFile(path.join(repoRoot, file), "utf8").catch(() => null)
    if (body === null) continue
    for (const match of body.matchAll(/(?:\.\.\/)*(?:docs\/)?([A-Za-z0-9._-]+\.md)\b/g)) {
      referenced.add(`docs/${match[1]}`)
    }
  }

  return [...referenced]
}

/**
 * Locale directories are the ones that carry their own landing page. `troubleshooting/` is nested
 * content that every locale repeats, not a locale, so it must not be mistaken for one.
 */
async function siteLocales() {
  const entries = await readdir(contentRoot, { withFileTypes: true })
  const locales = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (await exists(path.join(contentRoot, entry.name, "index.mdx"))) locales.push(entry.name)
  }
  return locales
}

/** Absolute route targets from inline Markdown links, which is how the site cross-references pages. */
function collectRouteLinks(body) {
  return [...body.matchAll(/\[[^\]]*\]\((\/[^)\s]*)\)/g)].map((match) => match[1])
}

async function run() {
  const filePaths = (await walk(contentRoot)).filter((p) => p.endsWith(".mdx"))
  const routeSet = new Set()
  const errors = []
  const locales = await siteLocales()
  const pages = []

  for (const filePath of filePaths) {
    const body = await readFile(filePath, "utf8")
    const relative = toPosix(path.relative(repoRoot, filePath))
    const route = routeFromFile(filePath)
    routeSet.add(route)
    pages.push({ body, relative, route })

    if (!hasFrontmatterKey(body, "title")) {
      errors.push(`${relative}: missing frontmatter key 'title'`)
    }
    if (!hasFrontmatterKey(body, "description")) {
      errors.push(`${relative}: missing frontmatter key 'description'`)
    }
  }

  // A translated page that links to another locale silently drops the reader into a language they
  // did not choose. Every locale carries the same page set, so the correct target always exists and
  // a cross-locale link is always a mistake rather than a deliberate reference.
  for (const { body, relative, route } of pages) {
    const owner = locales.find((locale) => route.startsWith(`/${locale}/`)) ?? null
    for (const target of collectRouteLinks(body)) {
      if (!routeSet.has(target)) {
        errors.push(`${relative}: link target is not a page: ${target}`)
        continue
      }
      const linked = locales.find((locale) => target.startsWith(`/${locale}/`)) ?? null
      if (linked === owner) continue
      const expected = owner === null ? target.replace(`/${linked}/`, "/") : `/${owner}${target}`
      errors.push(
        `${relative}: links to the ${linked ?? "default"} locale: ${target}`
        + `${routeSet.has(expected) ? ` (use ${expected})` : ""}`,
      )
    }
  }

  const sidebarRaw = await readFile(sidebarPath, "utf8")
  const sidebar = JSON.parse(sidebarRaw)
  const links = (sidebar.sections ?? [])
    .flatMap((section) => section.items ?? [])
    .map((item) => item.link)

  for (const link of links) {
    if (!routeSet.has(link)) {
      errors.push(`sidebar link has no page: ${link}`)
    }
  }

  const engineering = await validateEngineeringDocs(errors)

  if (errors.length > 0) {
    console.error("Docs validation failed:")
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    process.exit(1)
  }

  console.log(
    `Docs validation passed: ${filePaths.length} pages, ${links.length} sidebar links, `
    + `${engineering.checked} engineering docs, ${engineering.links} local links.`,
  )
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
