import path from "node:path";
import type { SearchContentParams, SearchContentResult, SearchContentFile, SearchContentHit } from "@varin/protocol";
import type { AgentInputContext, HarnessActorContext } from "@varin/protocol";
import type { WorkspaceContentSearchRequest, WorkspaceContentSearchOptions, WorkspaceContentSearchResult, WorkspaceSearchHit } from "../search/content.js";
import type { ExploreFileReader } from "./explore-file-reader.js";
import { compileGlobFilter } from "./glob-matcher.js";
import { uniqueFileCoverage } from "./explore-distinctiveness.js";

import type { WorkingBranchQuerySnapshot, WorkingBranchPinOptions } from "./working-state/working-branch-query.js";
import type { KernelComputeText } from "../kernel/compute-service.js";

export interface HarnessSearchDeps {
  search(request: WorkspaceContentSearchRequest & { query: string; workspaceId: string }, options: WorkspaceContentSearchOptions): Promise<WorkspaceContentSearchResult>;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
  readFile?: ExploreFileReader;
  /** Dirty paths this turn's fixed source still owns (D-088). */
  draftPaths?: (sessionId: string, context: AgentInputContext) => readonly string[];
  pinWorkingBranchQuery?: (sessionId: string, options?: WorkingBranchPinOptions) => Promise<WorkingBranchQuerySnapshot | null>;
}

export interface HarnessSearchContext {
  workspaceId: string | null;
  workspaceScope?: readonly string[];
  signal: AbortSignal;
  actor?: HarnessActorContext;
  inputContext?: AgentInputContext;
  /**
   * Explore-only working hit budget. Absent for `search.content` / grep, which
   * keep `params.limit` as the displayed-hit cap and `maxResults = 3 * limit`.
   */
  candidateBudget?: number;
  /** Explore-only per-file hit cap applied before the working budget. */
  hitsPerFile?: number;
  /** An exact query handle, not expanded workspace bytes. */
  pinnedBranchQuery?: WorkingBranchQuerySnapshot | null;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 20_000;

function fileScore(input: {
  hits: number;
  path: string;
  root: string;
  gitModified: boolean;
  ageDays: number;
}): number {
  const { hits, path, gitModified, ageDays } = input;
  const recency = gitModified ? 1 : Math.exp(-ageDays / 30);
  const pathPref = /test|spec|__tests__|fixtures/.test(path) ? 0.6 : 1.0;
  const depth = path.split("/").length - 1;
  const depthPenalty = 0.05 * Math.max(0, depth - 3);
  return 0.5 * Math.log1p(hits) + 0.3 * recency + 0.2 * pathPref - depthPenalty;
}

function toSearchFile(path: string, fileHits: WorkspaceSearchHit[]): SearchContentFile {
  return {
    path,
    hits: fileHits.map((hit): SearchContentHit => ({
      line: hit.line,
      text: hit.preview,
      before: hit.before ?? [],
      after: hit.after ?? [],
    })),
  };
}

function takeDepthFirst(files: SearchContentFile[], limit: number): SearchContentFile[] {
  let remaining = limit;
  const limited: SearchContentFile[] = [];
  for (const file of files) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, file.hits.length);
    limited.push({ path: file.path, hits: file.hits.slice(0, take) });
    remaining -= take;
  }
  return limited;
}

/** Round-robin one hit per file, then deepen. Drops files only when file count exceeds the budget. */
function takeBreadthFirst(files: SearchContentFile[], limit: number): { files: SearchContentFile[]; filesDropped: number } {
  const kept = files.length > limit ? files.slice(0, limit) : files;
  const filesDropped = files.length - kept.length;
  const cursors = kept.map((file) => ({ path: file.path, source: file.hits, hits: [] as SearchContentHit[] }));
  let remaining = limit;
  let depth = 0;
  while (remaining > 0) {
    let progressed = false;
    for (const cursor of cursors) {
      if (remaining <= 0) break;
      if (depth < cursor.source.length) {
        cursor.hits.push(cursor.source[depth]!);
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
    depth += 1;
  }
  return {
    files: cursors.filter((cursor) => cursor.hits.length > 0).map(({ path, hits }) => ({ path, hits })),
    filesDropped,
  };
}

function groupAndSort(
  hits: WorkspaceSearchHit[],
  root: string,
  limit: number,
  options?: { hitsPerFile?: number; useFileScore?: boolean; breadthFirst?: boolean },
): { files: SearchContentFile[]; totalHits: number; totalFiles: number; perFileCapped: boolean; filesDropped: number } {
  const byFile = new Map<string, WorkspaceSearchHit[]>();
  for (const hit of hits) {
    const path = hit.resource.resourceId;
    const fileHits = byFile.get(path) ?? [];
    fileHits.push(hit);
    byFile.set(path, fileHits);
  }

  const hitsPerFile = options?.hitsPerFile;
  let perFileCapped = false;
  const prepared = Array.from(byFile.entries()).map(([path, fileHits]) => {
    const ordered = [...fileHits].sort((a, b) => a.line - b.line);
    if (hitsPerFile !== undefined && ordered.length > hitsPerFile) {
      perFileCapped = true;
      return { path, hits: ordered.slice(0, hitsPerFile) };
    }
    return { path, hits: ordered };
  });

  const useFileScore = options?.useFileScore !== false;
  const scored = prepared.map((file) => ({
    ...file,
    score: useFileScore
      ? fileScore({
        hits: file.hits.length,
        path: file.path,
        root,
        gitModified: false, // TODO: integrate with git status
        ageDays: 0, // TODO: integrate with file mtime
      })
      : 0,
  }));
  scored.sort((a, b) => {
    if (useFileScore && b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  const files: SearchContentFile[] = scored.map(({ path, hits: fileHits }) => toSearchFile(path, fileHits));
  const totalHits = hits.length;
  const totalFiles = byFile.size;
  const displayedHits = files.reduce((sum, file) => sum + file.hits.length, 0);

  if (displayedHits <= limit) {
    return { files, totalHits, totalFiles, perFileCapped, filesDropped: 0 };
  }
  if (options?.breadthFirst === true) {
    const allocated = takeBreadthFirst(files, limit);
    return { files: allocated.files, totalHits, totalFiles, perFileCapped, filesDropped: allocated.filesDropped };
  }
  return { files: takeDepthFirst(files, limit), totalHits, totalFiles, perFileCapped, filesDropped: 0 };
}

const unavailableResult = (): SearchContentResult => ({
  status: "unavailable",
  files: [],
  totalHits: 0,
  totalFiles: 0,
  searchedFiles: 0,
  partial: false,
});

const emptyResult = (): SearchContentResult => ({
  status: "empty",
  files: [],
  totalHits: 0,
  totalFiles: 0,
  searchedFiles: 0,
  partial: false,
});


export type HarnessSearchService = ReturnType<typeof createHarnessSearchService>;
export function createHarnessSearchService(deps: HarnessSearchDeps) {
  return {
    async search(params: SearchContentParams, ctx: HarnessSearchContext): Promise<SearchContentResult> {
      const workspaceId=ctx.workspaceId;
      if(!workspaceId)return unavailableResult();
      const root=await deps.resolveWorkspaceRoot(workspaceId);if(!root)return unavailableResult();
      if(ctx.inputContext?.source==="surface"&&ctx.inputContext.workspaceId!==workspaceId)return unavailableResult();
      if(typeof params.pattern!=="string"||!params.pattern.trim())return emptyResult();
      if(ctx.signal.aborted)return {...emptyResult(),partial:true};
      const normalizePrefix=(value:string):string|null=>{
        const absolute=path.resolve(root,value);const relative=path.relative(root,absolute).replaceAll("\\","/");
        return path.isAbsolute(relative)||relative.split("/").includes("..")?null:relative;
      };
      const toPrefixes=(values:readonly string[]|undefined)=>{
        if(values===undefined)return [""];const result=values.map(normalizePrefix);
        return result.some(r=>r===null)?[]:result as string[];
      };
      const within=(file:string,prefix:string)=>{
        if(process.platform==="win32"){file=file.toLowerCase();prefix=prefix.toLowerCase();}
        return !prefix||file===prefix||file.startsWith(prefix+"/");
      };
      const allowed=toPrefixes(ctx.workspaceScope),requested=toPrefixes(params.path===undefined?undefined:[params.path]);
      const prefixes=[...new Set(allowed.flatMap(a=>requested.flatMap(r=>within(r,a)?[r]:within(a,r)?[a]:[])))];
      if(!prefixes.length)return emptyResult();
      const glob=compileGlobFilter(params.glob);if(!glob)return unavailableResult();
      const inView=(file:string)=>prefixes.some(prefix=>within(file,prefix))&&glob.matches(file);
      const limit=params.limit??DEFAULT_LIMIT;
      const candidateMode=ctx.candidateBudget!==undefined;
      const candidateBudget=Math.max(1,ctx.candidateBudget??limit);
      const backendLimit=candidateMode?undefined:limit*3;
      const before=Math.max(0,params.before??params.context??0),after=Math.max(0,params.after??params.context??0);
      const timeout=new AbortController();const timer=setTimeout(()=>timeout.abort(new DOMException("Search timed out","AbortError")),DEFAULT_TIMEOUT_MS);
      const signal=AbortSignal.any([ctx.signal,timeout.signal]);
      let ownedPin:WorkingBranchQuerySnapshot|null=null;
      try {
        const pinned=ctx.pinnedBranchQuery??(ctx.actor&&deps.pinWorkingBranchQuery
          ? ownedPin=await deps.pinWorkingBranchQuery(ctx.actor.sessionId,{roots:prefixes,signal}) : null);
        const overlays:KernelComputeText[]=[];
        const context=ctx.inputContext??{source:"disk" as const};
        if(!pinned&&context.source==="surface"&&ctx.actor){
          const paths=deps.draftPaths?.(ctx.actor.sessionId,context)??context.dirtyPaths;
          for(const raw of paths){signal.throwIfAborted();const file=normalizePrefix(raw);if(file===null||!inView(file))continue;
            if(!deps.readFile)return unavailableResult();
            const snapshot=await deps.readFile(ctx.actor,file,signal,context);
            if(snapshot.status!=="ready"||snapshot.source!=="surface-draft")return unavailableResult();
            overlays.push({path:file,revision:snapshot.revision,text:snapshot.content});
          }
        }
        const request={query:params.pattern,workspaceId,...(prefixes.length===1&&prefixes[0]===""?{}:{paths:prefixes}),before,after,
          ...(backendLimit===undefined?{}:{maxResults:backendLimit}),...(glob.rgPatterns.length?{glob:glob.rgPatterns}:{}),
          ...(params.ignoreCase===undefined?{}:{ignoreCase:params.ignoreCase}),...(params.fixedStrings===undefined?{}:{fixedStrings:params.fixedStrings})};
        const result=pinned?await pinned.search(request,{signal}):await deps.search(request,{signal,...(overlays.length?{overlays}:{})});
        if(result.status==="cancelled")return {...emptyResult(),partial:true};
        if(result.status==="failure")return unavailableResult();
        if(result.status!=="ready")return emptyResult();
        const hits=result.hits.filter(hit=>inView(hit.resource.resourceId));
        const grouped=groupAndSort(hits,root,candidateMode?candidateBudget:limit,{
          ...(ctx.hitsPerFile===undefined?{}:{hitsPerFile:ctx.hitsPerFile}),useFileScore:!candidateMode,breadthFirst:candidateMode,
        });
        const shown=grouped.files.reduce((sum,file)=>sum+file.hits.length,0);
        const backendCapped=result.incomplete===true||(backendLimit!==undefined&&result.hits.length>=backendLimit);
        const partial=backendCapped||shown<grouped.totalHits||grouped.perFileCapped||grouped.filesDropped>0||signal.aborted;
        return {status:grouped.totalHits?"ready":"empty",files:grouped.files,totalHits:grouped.totalHits,totalFiles:grouped.totalFiles,
          searchedFiles:grouped.totalFiles,partial,
          ...(candidateMode?{filesDropped:grouped.filesDropped,fileCoverage:uniqueFileCoverage({filesDropped:grouped.filesDropped,backendIncomplete:result.incomplete===true,backendCapped})}:{})};
      }catch{return ctx.signal.aborted||timeout.signal.aborted?{...emptyResult(),partial:true}:unavailableResult();}
      finally{clearTimeout(timer);await ownedPin?.release();}
    },
  };
}
