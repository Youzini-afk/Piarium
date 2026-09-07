/**
 * Observation run for `explore.search`. Not a benchmark and not a test.
 *
 * plan 0.7 says the next retrieval decision (lexical index / bridging /
 * embedding) follows from *observed* "cannot find the entry point" failures,
 * but nothing produced that observation: every claim so far came from unit
 * tests and comparison numbers. This script asks real questions about this
 * repository and prints what the agent would actually receive, verbatim, for a
 * human to read.
 *
 * Run with:
 *
 *   bun run --cwd packages/web explore:observe
 *   bun run --cwd packages/web explore:observe -- --only 3 --full
 *
 * Shape discipline (D-140): this goes through the real
 * `createHarnessServiceHost` / `createExploreSearchService` / rg / structure
 * source / knowledge store. It does not reimplement retrieval, because the
 * three previous measurement mistakes all came from a script measuring a shape
 * the product does not run.
 *
 * What is simulated, and why that is faithful: there is no editor here, so no
 * dirty buffers exist and `agentInputDraftPaths` is empty. That is exactly the
 * production path when nothing is unsaved (D-082: no dirty capture → disk), so
 * the fixed-draft branches are simply not exercised.
 */
import { spawn } from "node:child_process";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocumentAuthority } from "../application-host/lib/documents/authority.js";
import { createHarnessPathAuthority } from "../application-host/lib/harness/path-authority.js";
import { createExploreFileReader } from "../application-host/lib/harness/explore-file-reader.js";
import { createHarnessServiceHost } from "../application-host/lib/harness/service-host.js";
import { createExploreSearchService } from "../application-host/lib/harness/explore-service.js";
import { createWorkspaceContentSearch } from "../application-host/lib/search/content.js";
import { createStructureSource } from "../application-host/lib/structure/source.js";
import { createTreeSitterStructureProvider } from "../application-host/lib/structure/tree-sitter-provider.js";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../application-host/lib/knowledge/store.js";
import { createSymbolGraphRuntime } from "../application-host/lib/knowledge/symbol-runtime.js";
import { createFsSearchRuntime } from "../application-host/lib/fs/search.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Real questions, each with the answer a maintainer would accept. `wants` is
 * only printed next to the result so a reader can judge; nothing scores it.
 */
const QUESTIONS: Array<{ ask: string; wants: string; anchors?: string[] }> = [
  {
    ask: "where is the explore.search service registered on the host router",
    wants: "harness-services.ts registering explore.search, and/or explore-service.ts creating it",
  },
  {
    ask: "how does explore decide which files to read after ripgrep returns hits",
    wants: "explore.ts rankCandidates / maxMaterializeReads / materializeBatch",
  },
  {
    ask: "what stops the agent from reading a stale captured draft after it writes a file",
    wants: "surface-snapshot-store supersede + documents/authority observeWrite (D-088)",
  },
  {
    ask: "where do we decide a tree-sitter grammar can produce an outline",
    wants: "languages.ts treeSitterTagsSpec / capabilitiesFromSpec, grammar-manifest tagsPath (D-128)",
  },
  {
    ask: "which code writes connects and associates edges into the knowledge graph",
    wants: "symbol-runtime loadGraphFacts + structure/connections classifyLiteralCall (D-109)",
  },
  {
    ask: "how is the parse budget for tree-sitter enforced and what happens when it runs out",
    wants: "tree-sitter-provider parseDocument progressCallback + constants STRUCTURE_PARSE_BUDGET_MS (D-102)",
  },
  {
    ask: "where is the write guard that refuses to overwrite unsaved user changes",
    wants: "documents/authority inspectAgentWriteTarget, document.writeGuard service (D-089)",
  },
  {
    ask: "how does a thread get its own working directory and when is it reclaimed",
    wants: "thread-worktree.ts materialize/reclaim, worktree-reclaim-guard (D-077)",
  },
  { ask: "explore.search", wants: "the registration end and the request end of that literal (wire completion)" },
  {
    ask: "what limits how many bytes explore returns to the model",
    wants: "explore.ts packExploreVisible / DEFAULT_BYTE_BUDGET and the OutputStore handle (D-090)",
  },
];

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const only = flag("only") ? Number(flag("only")) : null;
const full = args.includes("--full");
const skipScan = args.includes("--skip-scan");
/**
 * Reuse a catalog across runs. Building it takes minutes, and the point of this
 * script is to ask many questions, so pass the same directory to keep it:
 *
 *   bun run --cwd packages/web explore:observe -- --data-dir .observe
 *   bun run --cwd packages/web explore:observe -- --data-dir .observe --skip-scan --only 3
 */
const dataDirArg = flag("data-dir");

const line = (char = "─"): string => char.repeat(78);

const main = async (): Promise<void> => {
  const dataDir = dataDirArg
    ? path.resolve(repoRoot, dataDirArg)
    : await fsPromises.mkdtemp(path.join(os.tmpdir(), "piarium-explore-observe-"));
  if (dataDirArg) await fsPromises.mkdir(dataDir, { recursive: true });
  let store: KnowledgeStore | null = null;

  const documents = createDocumentAuthority({
    hostId: "explore-observe",
    dataDir,
    maxReadBytes: 2 * 1024 * 1024,
    isAllowedRoot: async () => true,
    isTrusted: async () => true,
  });
  const identity = await documents.resolveWorkspace({ path: repoRoot });
  const workspaceId = identity.workspaceId;
  process.stderr.write(`workspace ${workspaceId} → ${repoRoot}\n`);

  const paths = createHarnessPathAuthority({
    authorityId: "explore-observe",
    documents,
    fsPromises,
    pathModule: path,
  });
  const contentSearch = createWorkspaceContentSearch({
    documents,
    spawn,
    pathModule: path,
    env: process.env,
  });
  const structureSource = createStructureSource([createTreeSitterStructureProvider()]);
  const fileSearch = createFsSearchRuntime({
    fsPromises,
    path,
    spawn,
    resolveGitBinaryForSpawn: () => "git",
  });

  // The catalog the graph readers depend on. Built through the production
  // collector, not a parallel one.
  store = await openWorkspaceKnowledge({
    dataDir,
    hostId: "explore-observe",
    workspaceId,
    embedding: null,
  });
  const openStore = store;
  if (!skipScan) {
    const scanStarted = performance.now();
    const symbolGraph = createSymbolGraphRuntime({
      getStore: async () => openStore,
      documents,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "observation run does not start a language server" }),
      } as never,
      structureSource,
      searchFilesystemFiles: fileSearch.searchFilesystemFiles,
      onError: (error) => process.stderr.write(`catalog: ${String(error)}\n`),
    });
    process.stderr.write("building catalog (this is the D-140 path; expect minutes)…\n");
    await symbolGraph.scanWorkspace(workspaceId);
    const stats = await openStore.catalogStats();
    process.stderr.write(
      `catalog ready in ${Math.round(performance.now() - scanStarted)} ms: `
      + `${stats.fileCount} files / ${stats.symbolCount} symbols / ${stats.linkCount} links\n`,
    );
    await symbolGraph.dispose();
  }

  const host = createHarnessServiceHost({
    resolveWorkspaceRoot: async () => repoRoot,
    readExploreFile: createExploreFileReader(documents, paths),
    // No editor in this process, so nothing is unsaved (D-082).
    agentInputDraftPaths: () => [],
    search: async (request, options) => {
      const started = performance.now();
      const outcome = await contentSearch.searchContent({
        query: request.query,
        workspaceId: request.workspaceId,
        maxResults: request.maxResults,
        ...(request.paths === undefined ? {} : { paths: request.paths }),
        ...(request.glob === undefined ? {} : { glob: request.glob }),
        ...(request.excludeResourceIds === undefined ? {} : { excludeResourceIds: request.excludeResourceIds }),
        ...(request.ignoreCase === undefined ? {} : { ignoreCase: request.ignoreCase }),
        ...(request.fixedStrings === undefined ? {} : { fixedStrings: request.fixedStrings }),
      }, options);
      // The harness search service reports any failure as a bare "unavailable",
      // so the pattern, elapsed time and raw status are logged here.
      const hits = outcome.status === "ready" ? outcome.hits.length : 0;
      process.stderr.write(
        `  rg ${JSON.stringify(request.query)} max=${request.maxResults ?? "none"} `
        + `→ ${outcome.status} hits=${hits} ${Math.round(performance.now() - started)} ms`
        + `${outcome.status === "failure" ? ` :: ${outcome.message}` : ""}\n`,
      );
      return outcome;
    },
    structureSource,
    graphRecall: () => openStore,
    fileRelations: async (_workspaceId, resourceId) => {
      const relations = await openStore.getFileRelations(resourceId);
      if (!relations) return null;
      if (relations.imports.length === 0 && relations.connections.length === 0 && relations.associations.length === 0) {
        return { path: relations.path, documentRevision: relations.documentRevision, incomplete: relations.linksIncomplete, imports: [], connections: [] };
      }
      return {
        path: relations.path,
        documentRevision: relations.documentRevision,
        incomplete: relations.linksIncomplete,
        imports: relations.imports.map((item) => ({ specifier: item.specifier, line: item.line })),
        connections: relations.connections.map((item) => ({ callee: item.callee, literal: item.literal, line: item.line })),
      };
    },
  });

  // Sanity check before asking anything: explore reports a search failure as a
  // generic "unavailable", so the raw status is printed here instead.
  const probe = await contentSearch.searchContent({ query: "createExploreSearchService", workspaceId, maxResults: 3 });
  process.stderr.write(`search probe: ${JSON.stringify({ status: probe.status, message: (probe as { message?: string }).message })}\n`);
  try {
    const inspected = await documents.inspectWorkspace(workspaceId);
    process.stderr.write(`inspectWorkspace ok: ${inspected.root}\n`);
  } catch (error) {
    process.stderr.write(`inspectWorkspace THREW: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  const explore = createExploreSearchService(host);
  const ctx = {
    actor: { hostId: "explore-observe", sessionId: "observe", workspaceId },
    sessionId: "observe",
    signal: new AbortController().signal,
  } as never;

  const selected = only === null ? QUESTIONS : QUESTIONS.slice(only - 1, only);
  for (const [index, question] of selected.entries()) {
    const number = only === null ? index + 1 : only;
    process.stdout.write(`\n${line("═")}\n[${number}] ${question.ask}\n`);
    if (question.anchors) process.stdout.write(`anchors: ${question.anchors.join(", ")}\n`);
    process.stdout.write(`looking for: ${question.wants}\n${line()}\n`);

    const started = performance.now();
    let result: Awaited<ReturnType<typeof explore.handle>> | null = null;
    try {
      result = await explore.handle(
        { question: question.ask, ...(question.anchors ? { anchors: question.anchors } : {}) } as never,
        ctx,
      );
    } catch (error) {
      process.stdout.write(`THREW: ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }
    const elapsed = Math.round(performance.now() - started);

    const payload = result as unknown as {
      text?: string;
      snippets?: Array<{ path: string; startLine: number; endLine: number; why: string; unit?: { name: string; kind: string } }>;
      searched?: unknown;
      issues?: unknown[];
      details?: { graph?: unknown; structure?: unknown; relations?: unknown; provenance?: unknown[] };
    };

    process.stdout.write(`took ${elapsed} ms\n\n`);
    if (full) {
      process.stdout.write(`${payload.text ?? "(no text)"}\n`);
    } else {
      // Paths and reasons first: that is what decides whether the agent would
      // have found the entry point.
      for (const snippet of payload.snippets ?? []) {
        const unit = snippet.unit ? ` ${snippet.unit.kind} ${snippet.unit.name}` : "";
        process.stdout.write(`  ${snippet.path}:${snippet.startLine}-${snippet.endLine}${unit}\n      why: ${snippet.why}\n`);
      }
      if ((payload.snippets ?? []).length === 0) process.stdout.write("  (no snippets)\n");
    }
    process.stdout.write(`\nsearched: ${JSON.stringify(payload.searched)}\n`);
    if (payload.details?.graph) process.stdout.write(`graph:    ${JSON.stringify(payload.details.graph)}\n`);
    if (payload.details?.structure) process.stdout.write(`structure:${JSON.stringify(payload.details.structure)}\n`);
    if (payload.details?.relations) process.stdout.write(`relations:${JSON.stringify(payload.details.relations)}\n`);
    if ((payload.issues ?? []).length > 0) process.stdout.write(`issues:   ${JSON.stringify(payload.issues)}\n`);
  }

  await host.dispose();
  await store?.close();
  process.stdout.write(`\n${line("═")}\ndata dir kept for inspection: ${dataDir}\n`);
};

await main();
