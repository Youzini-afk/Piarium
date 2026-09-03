import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceMap } from "@piarium/protocol";
import type { ShellSupervisor } from "./shell-supervisor.js";
import type { OutputStore } from "./output-store.js";
import type { PathLockService } from "./path-lock.js";
import type { HarnessSearchService } from "./search-service.js";

export function createShellExecService(supervisor: ShellSupervisor): HarnessService<"shell.exec"> {
  return {
    handle: async (params, _ctx: HarnessServiceContext) => {
      return supervisor.exec(params.command, {
        cwd: params.cwd,
        waitMs: params.waitMs ?? 60_000,
      });
    },
  };
}

export function createShellReadService(supervisor: ShellSupervisor): HarnessService<"shell.read"> {
  return {
    handle: async (params, _ctx: HarnessServiceContext) => {
      return supervisor.read(params.id, params.offset, params.length);
    },
  };
}

export function createShellWriteService(supervisor: ShellSupervisor): HarnessService<"shell.write"> {
  return {
    handle: async (params, _ctx: HarnessServiceContext) => {
      const accepted = await supervisor.write(params.id, params.text);
      return { accepted };
    },
  };
}

export function createShellKillService(supervisor: ShellSupervisor): HarnessService<"shell.kill"> {
  return {
    handle: async (params, _ctx: HarnessServiceContext) => {
      const killed = await supervisor.kill(params.id);
      return { killed };
    },
  };
}

export function createOutputStoreService(store: OutputStore): HarnessService<"output.store"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const result = store.store(ctx.sessionId, params.text, params.label);
      return { handle: result.handle, total: result.total };
    },
  };
}

export function createOutputReadService(store: OutputStore): HarnessService<"output.read"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const slice = store.read(ctx.sessionId, params.handle, params.offset, params.length);
      if (!slice) {
        throw new Error(`Output handle not found: ${params.handle}`);
      }
      return slice;
    },
  };
}

export function createSearchContentService(search: HarnessSearchService): HarnessService<"search.content"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      return search.search(params, ctx);
    },
  };
}

export function createFsLockService(locks: PathLockService): HarnessService<"fs.lock"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (params.action === "acquire") {
        const held = await locks.acquire(ctx.sessionId, params.path, params.timeoutMs);
        return { held };
      }
      if (params.action === "release") {
        const released = locks.release(ctx.sessionId, params.path);
        return { held: !released };
      }
      throw new Error(`Unknown fs.lock action: ${params.action}`);
    },
  };
}

export type { HarnessServiceMap };
