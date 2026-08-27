#!/usr/bin/env node

import { HostController } from "./host-controller.js";
import { parseHostArguments, resolveHostRuntimeOptions } from "./host-arguments.js";
import { createProcessTransport } from "./transport.js";

function redirectConsoleToStderr(): void {
  const write = (...values: unknown[]) => {
    process.stderr.write(`${values.map((value) => String(value)).join(" ")}\n`);
  };
  console.log = write;
  console.info = write;
  console.debug = write;
}

async function run(): Promise<void> {
  const args = parseHostArguments(process.argv.slice(2));
  const runtime = resolveHostRuntimeOptions(args);
  if (args.forceStdio) redirectConsoleToStderr();
  if (args.agentDir !== undefined) process.env.PI_CODING_AGENT_DIR = args.agentDir;
  const controller = new HostController({
    ...(args.agentDir === undefined ? {} : { agentDir: args.agentDir }),
    ...(args.projectTrustOverride === undefined
      ? {}
      : { projectTrustOverride: args.projectTrustOverride }),
    ...runtime,
    transport: createProcessTransport(args.forceStdio),
    workerRole: args.workerRole,
  });
  controller.start();

  let shutdown: Promise<void> | undefined;
  const requestShutdown = () => {
    shutdown ??= controller.dispose();
    return shutdown;
  };
  const handleSignal = () => {
    void requestShutdown().finally(() => process.exit(0));
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  if (process.platform !== "win32") process.once("SIGHUP", handleSignal);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
