#!/usr/bin/env node

import { HostController } from "./host-controller.js";
import { createProcessTransport } from "./transport.js";

interface HostArguments {
  agentDir?: string;
  forceStdio: boolean;
  projectTrustOverride?: boolean;
}

function parseArguments(argv: string[]): HostArguments {
  const result: HostArguments = { forceStdio: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--stdio") {
      result.forceStdio = true;
    } else if (argument === "--trust-project") {
      result.projectTrustOverride = true;
    } else if (argument === "--deny-project") {
      result.projectTrustOverride = false;
    } else if (argument === "--agent-dir") {
      const value = argv[++index];
      if (!value) throw new Error("--agent-dir requires a path");
      result.agentDir = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return result;
}

function redirectConsoleToStderr(): void {
  const write = (...values: unknown[]) => {
    process.stderr.write(`${values.map((value) => String(value)).join(" ")}\n`);
  };
  console.log = write;
  console.info = write;
  console.debug = write;
}

async function run(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.forceStdio) redirectConsoleToStderr();
  const controller = new HostController({
    ...(args.agentDir === undefined ? {} : { agentDir: args.agentDir }),
    ...(args.projectTrustOverride === undefined
      ? {}
      : { projectTrustOverride: args.projectTrustOverride }),
    transport: createProcessTransport(args.forceStdio),
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
