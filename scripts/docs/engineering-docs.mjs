/**
 * Contract checks for the repository's engineering documentation.
 *
 * The docs site under `packages/docs` has its own frontmatter and sidebar validation. The
 * engineering docs (`AGENTS.md`, the READMEs, and `docs/**`) had no gate at all, which is how the
 * delivery roadmap fell 48 commits behind an entire new subsystem without anything failing.
 *
 * These checks are deliberately deterministic. They assert properties that are wrong in a way a
 * reader can act on, and they avoid time- or commit-count thresholds that would fail a document
 * for merely being stable.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const addDays = (isoDate, days) => {
  const shifted = new Date(`${isoDate}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

/** Documents that must keep a `Status:` and `Last updated:` header. */
export const REQUIRED_STATUS_HEADER_DOCS = ["docs/architecture.md", "docs/roadmap.md"]

/**
 * Documents that are intentionally not reachable from another document.
 *
 * Keep this empty unless a file genuinely has no index. Adding an entry is a decision to let a
 * document drift unnoticed, so it needs a stated reason.
 */
export const ORPHAN_ALLOWLIST = Object.freeze({})

const stripCodeFences = (text) => text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "))

/**
 * Collect link targets from inline links, reference definitions, and bare autolinks.
 * Returns targets with any `#fragment` removed and external schemes filtered out.
 */
export const collectLocalLinkTargets = (markdown) => {
  const body = stripCodeFences(markdown)
  const targets = []

  const push = (raw) => {
    if (typeof raw !== "string") return
    const trimmed = raw.trim()
    if (trimmed.length === 0) return
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return
    if (trimmed.startsWith("#")) return
    const withoutFragment = trimmed.split("#")[0]
    if (withoutFragment.length === 0) return
    targets.push(decodeURI(withoutFragment))
  }

  for (const match of body.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) push(match[1])
  for (const match of body.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)) push(match[1])

  return targets
}

/** Extract the `Status:` and `Last updated:` header values, when present. */
export const readStatusHeader = (markdown) => {
  const status = /^Status:\s*(.+?)\s*$/m.exec(markdown)
  const updated = /^Last updated:\s*(.+?)\s*$/m.exec(markdown)
  return {
    status: status ? status[1] : null,
    lastUpdated: updated ? updated[1] : null,
  }
}

/**
 * Check a `Last updated:` header for well-formedness: ISO date, not in the future.
 * The header is a human freshness hint, not a contract — commit-date comparison used to force
 * contributors to bump it on every edit, which blocked unrelated work without proving anything.
 */
export const checkLastUpdated = ({ lastUpdated, today }) => {
  if (lastUpdated === null) return null
  if (!ISO_DATE.test(lastUpdated)) {
    return `'Last updated: ${lastUpdated}' is not an ISO YYYY-MM-DD date`
  }
  // `today` is UTC while an author writes their local date, so allow one day of timezone slack
  // rather than failing contributors who are ahead of UTC.
  if (lastUpdated > addDays(today, 1)) {
    return `'Last updated: ${lastUpdated}' is in the future (today is ${today})`
  }
  return null
}

/**
 * Find documents that nothing else links to.
 *
 * An unreferenced design or plan document is the strongest objective signal that the index did not
 * absorb a body of work: the composable-workbench plan was orphaned across the eleven phases that
 * executed against it.
 */
export const findOrphanDocs = ({ candidates, referencedPaths, allowlist = ORPHAN_ALLOWLIST }) => (
  candidates.filter((candidate) => !referencedPaths.has(candidate) && !(candidate in allowlist))
)
