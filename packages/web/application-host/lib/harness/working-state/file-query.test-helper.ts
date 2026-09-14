/** Pure model for legacy in-memory store fixtures. Production never imports it;
 * native query behavior has independent release-kernel acceptance. */
import { randomUUID } from "node:crypto";
import { compileGlobFilter } from "../glob-matcher.js";
import { listBranchView } from "./branch-view.js";
import type { RecoveryState, WorkingStatePinnedRoot } from "./types.js";
import type { WorkingStateFileQuery, WorkingStateQueryOptions, WorkingStateQueryResult } from "./query-contract.js";
import type { KernelComputeRecord } from "../../kernel/protocol.generated.js";

export async function queryTestFiles(pin:WorkingStatePinnedRoot,states:Record<string,RecoveryState>,
  read:(hash:string)=>Promise<Buffer|null>,request:WorkingStateFileQuery,options:WorkingStateQueryOptions={}):Promise<WorkingStateQueryResult> {
  options.signal?.throwIfAborted();
  const within=(file:string,root:string)=>!root||file===root||file.startsWith(root+"/");
  const roots=request.paths??[""];
  const selected=request.files?.map(f=>f.path);
  const glob=compileGlobFilter(request.globs);if(!glob)throw new Error("Invalid query glob");
  const visible=(file:string)=>roots.some(root=>within(file,root))&&(!selected||selected.includes(file))&&glob.matches(file)
    &&!Object.entries(states).some(([parent,state])=>state.kind==="missing"&&within(file,parent));
  const records:KernelComputeRecord[]=[];let scanned=0,limited=false;
  const revision="working-branch:"+pin.branchId+"@"+pin.writeRevision+":base";
  const emit=(kind:string,path:string,data:Record<string,unknown>)=>records.push({kind,path,revision,data});
  if(request.operation==="list"){
    for(const e of listBranchView(states,"",{branchId:pin.branchId,revision:pin.writeRevision})){const file=e.path==="."?"":e.path;if(visible(file))emit("entry",file,{kind:e.kind});}
  }else{
    const escape=(value:string)=>value.replace(/[.*+?^$(){}|[\]\\]/g,"\\$&");
    const matcher=request.operation==="search"?new RegExp(request.fixedStrings?escape(request.query??""):request.query??"",request.ignoreCase?"i":""):null;
    for(const [file,state] of Object.entries(states).sort(([a],[b])=>a.localeCompare(b))){
      options.signal?.throwIfAborted();if(state.kind!=="regular-file"||!visible(file))continue;
      const bytes=await read(state.objectHash);if(!bytes)throw new Error("Fixture object is missing");scanned++;
      if(request.operation==="bytes"){const start=request.byteOffset??0,end=Math.min(bytes.length,start+(request.byteLength??65536));emit("bytes",file,{bytesBase64:bytes.subarray(start,end).toString("base64"),offset:start,byteLength:bytes.length});continue;}
      const text=bytes.toString("utf8");if(text.includes("\0")||!Buffer.from(text).equals(bytes)){emit("document",file,{status:"binary"});continue;}
      const lines=text.split("\n").map(l=>l.replace(/\r$/,""));
      if(matcher){const searchLines=text.endsWith("\n")?lines.slice(0,-1):lines;for(const [index,line] of searchLines.entries()){
        const matched=matcher.exec(line);if(!matched)continue;
        emit("hit",file,{line:index+1,column:matched.index+1,preview:line,before:searchLines.slice(Math.max(0,index-(request.before??0)),index),after:searchLines.slice(index+1,index+1+(request.after??0))});
        if(request.maxResults!==undefined&&records.length>=request.maxResults){limited=true;break;}
      }}else{const body=request.startLine===undefined&&request.endLine===undefined?text:lines.slice((request.startLine??1)-1,request.endLine??lines.length).join("\n");emit("text",file,{text:body,offset:0,final:true,byteLength:bytes.length});}
      if(limited)break;
    }
  }
  options.signal?.throwIfAborted();if(options.onRecords&&records.length)await options.onRecords(records);
  return {jobId:randomUUID(),kernelEpoch:"test-model",workspaceId:pin.workspaceId,root:pin.root,status:limited?"partial":records.length?"ready":"empty",
    records:options.collect===false?[]:records,nextCursor:records.length,endCursor:records.length,scannedFiles:scanned,message:null};
}
