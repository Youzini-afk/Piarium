import { languageIdForPath } from "@piarium/protocol";
import type {
  LanguageSupportAPI,
  LanguageSupportInstallResult,
  LanguageSupportLanguageRow,
  LanguageSupportStatus,
  StructureGrammarStatus,
} from "@piarium/application-client";
import { NO_STRUCTURE_CAPABILITIES } from "../structure/types.js";
import { capabilitiesFromSpec, treeSitterLanguageSpec } from "../structure/languages.js";
import type { FileSearchItem } from "../fs/types.js";

/** Enumerate this many files, then stop and set `partial` (D-120). */
export const LANGUAGE_DISTRIBUTION_FILE_LIMIT = 8_000;
/** Per-workspace cache for getStatus. Settings is a user gesture (D-120). */
export const LANGUAGE_DISTRIBUTION_CACHE_MS = 30_000;

export interface LanguageSupportRuntimeOptions {
  searchFilesystemFiles: (
    rootPath: string,
    options: { query: string; respectGitignore?: boolean; limit?: number; signal?: AbortSignal },
  ) => Promise<FileSearchItem[]>;
  inspectWorkspace: (workspaceId: string) => Promise<{ root: string }>;
  fileLimit?: number;
  cacheTtlMs?: number;
  now?: () => number;
  /**
   * Language ids that have a downloadable pack but are not on this machine.
   * Empty until the grammar manifest is wired (commit 5).
   */
  installableLanguageIds?: () => readonly string[];
  installedLanguageIds?: () => readonly string[];
  userUnverifiedLanguageIds?: () => readonly string[];
}

export interface LanguageSupportRuntime extends LanguageSupportAPI {
  noteRequest(languageId: string, workspaceId?: string): void;
  peekWanted(workspaceId: string): readonly string[];
}

const unsupportedInstall = (languageId: string): LanguageSupportInstallResult => ({
  status: "failed",
  languageId,
  reason: "unsupported",
  message: "On-demand grammar install is not available.",
});

export function resolveGrammarStatus(
  languageId: string,
  options: {
    installable: ReadonlySet<string>;
    installed: ReadonlySet<string>;
    userUnverified: ReadonlySet<string>;
  },
): StructureGrammarStatus {
  if (treeSitterLanguageSpec(languageId)) return "bundled";
  if (options.userUnverified.has(languageId)) return "user-unverified";
  if (options.installed.has(languageId)) return "installed";
  if (options.installable.has(languageId)) return "available";
  return "absent";
}

export function createLanguageSupportRuntime(options: LanguageSupportRuntimeOptions): LanguageSupportRuntime {
  const fileLimit = options.fileLimit ?? LANGUAGE_DISTRIBUTION_FILE_LIMIT;
  const cacheTtlMs = options.cacheTtlMs ?? LANGUAGE_DISTRIBUTION_CACHE_MS;
  const now = options.now ?? Date.now;
  const wantedByWorkspace = new Map<string, Set<string>>();
  const cache = new Map<string, { expiresAt: number; status: LanguageSupportStatus }>();

  const sets = () => ({
    installable: new Set(options.installableLanguageIds?.() ?? []),
    installed: new Set(options.installedLanguageIds?.() ?? []),
    userUnverified: new Set(options.userUnverifiedLanguageIds?.() ?? []),
  });

  const noteRequest = (languageId: string, workspaceId?: string): void => {
    if (!languageId || !workspaceId) return;
    const catalog = sets();
    const status = resolveGrammarStatus(languageId, catalog);
    if (status !== "available") return;
    const wanted = wantedByWorkspace.get(workspaceId) ?? new Set<string>();
    wanted.add(languageId);
    wantedByWorkspace.set(workspaceId, wanted);
    cache.delete(workspaceId);
  };

  const getStatus = async (request: { workspaceId: string }): Promise<LanguageSupportStatus> => {
    const workspaceId = request.workspaceId.trim();
    if (!workspaceId) {
      return { workspaceId, languages: [], partial: false, scannedFiles: 0, fileLimit };
    }
    const cached = cache.get(workspaceId);
    if (cached && cached.expiresAt > now()) return cached.status;

    const catalog = sets();
    const workspace = await options.inspectWorkspace(workspaceId);
    const files = await options.searchFilesystemFiles(workspace.root, {
      query: "",
      respectGitignore: true,
      limit: fileLimit + 1,
    });
    const partial = files.length > fileLimit;
    const scanned = files.slice(0, fileLimit);
    const counts = new Map<string, number>();
    for (const file of scanned) {
      const languageId = languageIdForPath(file.relativePath);
      if (!languageId) continue;
      counts.set(languageId, (counts.get(languageId) ?? 0) + 1);
    }

    const wanted = wantedByWorkspace.get(workspaceId) ?? new Set<string>();
    const languageIds = new Set([...counts.keys(), ...wanted]);
    const languages: LanguageSupportLanguageRow[] = [...languageIds].map((languageId) => ({
      languageId,
      grammarStatus: resolveGrammarStatus(languageId, catalog),
      capabilities: capabilitiesFromSpec(treeSitterLanguageSpec(languageId)),
      fileCount: counts.get(languageId) ?? 0,
      wanted: wanted.has(languageId),
    }));
    languages.sort((left, right) => {
      if (left.wanted !== right.wanted) return left.wanted ? -1 : 1;
      if (right.fileCount !== left.fileCount) return right.fileCount - left.fileCount;
      return left.languageId.localeCompare(right.languageId);
    });

    const status: LanguageSupportStatus = {
      workspaceId,
      languages,
      partial,
      scannedFiles: scanned.length,
      fileLimit,
    };
    cache.set(workspaceId, { expiresAt: now() + cacheTtlMs, status });
    return status;
  };

  return {
    noteRequest,
    peekWanted: (workspaceId) => [...(wantedByWorkspace.get(workspaceId) ?? [])],
    getStatus,
    install: async ({ languageId }) => unsupportedInstall(languageId),
    cancelInstall: async ({ languageId }) => unsupportedInstall(languageId),
    importUserGrammar: async ({ languageId }) => unsupportedInstall(languageId),
  };
}

export const emptyLanguageSupportCapabilities = NO_STRUCTURE_CAPABILITIES;
