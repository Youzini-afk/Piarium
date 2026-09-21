import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKernelClient } from "./kernel-client.js";
import { createKernelComputeService, type KernelComputeService } from "./compute-service.js";

/** Explicit fixture for tests and observation scripts. It is not a production
 * fallback: all runs require the exact built release kernel. */
export function createNativeComputeTestHarness() {
  let initialized: Promise<{ service: KernelComputeService; dispose(): Promise<void> }> | undefined;
  const get = () => initialized ??= (async () => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repo, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
    await fs.access(kernelPath);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-native-compute-fixture-"));
    const buildVersion = (JSON.parse(await fs.readFile(path.join(repo,"package.json"),"utf8")) as {version:string}).version;
    const client = createKernelClient({hostId:"compute-fixture",storageRoot:root,kernelPath,buildVersion,allowCargoDevRunner:false});
    try { await client.start(); } catch (error) { await client.close(); await fs.rm(root,{recursive:true,force:true}); throw error; }
    const service = createKernelComputeService({client,resolveIdentity:async cwd=>({workspaceId:"fixture",executionWorkspaceId:"fixture",canonicalRoot:await fs.realpath(cwd)})});
    return {service,dispose:async()=>{try{await service.dispose();}finally{await client.close();await fs.rm(root,{recursive:true,force:true});}}};
  })();
  const compute: KernelComputeService = {
    registerGrammar: async (...args)=>(await get()).service.registerGrammar(...args),
    text: async (...args)=>(await get()).service.text(...args),
    directory: async (...args)=>(await get()).service.directory(...args),
    dispose: async()=>{if(initialized)await(await initialized).dispose();},
  };
  return compute;
}
