import {
  RUNTIME_SOURCE_KINDS,
  RUNTIME_WORKER_ROLES,
  type RuntimeSourceKind,
  type RuntimeWorkerRole,
} from "@piarium/protocol";

export interface HostArguments {
  agentDir?: string;
  forceStdio: boolean;
  packageRoot?: string;
  projectTrustOverride?: boolean;
  runtimeSource?: RuntimeSourceKind;
  workerRole: RuntimeWorkerRole;
}

function parseRuntimeSource(value: string): RuntimeSourceKind {
  if ((RUNTIME_SOURCE_KINDS as readonly string[]).includes(value)) {
    return value as RuntimeSourceKind;
  }
  throw new Error(`Unknown runtime source: ${value}`);
}

export function parseHostArguments(argv: string[]): HostArguments {
  const result: HostArguments = { forceStdio: false, workerRole: "session" };
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
    } else if (argument === "--package-root") {
      const value = argv[++index];
      if (!value) throw new Error("--package-root requires a path");
      result.packageRoot = value;
    } else if (argument === "--runtime-source") {
      const value = argv[++index];
      if (!value) throw new Error("--runtime-source requires a value");
      result.runtimeSource = parseRuntimeSource(value);
    } else if (argument === "--worker-role") {
      const value = argv[++index];
      if (!value || !RUNTIME_WORKER_ROLES.includes(value as RuntimeWorkerRole)) {
        throw new Error(`--worker-role must be one of: ${RUNTIME_WORKER_ROLES.join(", ")}`);
      }
      result.workerRole = value as RuntimeWorkerRole;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return result;
}

export function resolveHostRuntimeOptions(args: HostArguments): {
  packageRoot?: string;
  runtimeSource?: RuntimeSourceKind;
} {
  const packageRoot = args.packageRoot ?? process.env.PIARIUM_PI_PACKAGE_ROOT;
  const runtimeSource = args.runtimeSource
    ?? (process.env.PIARIUM_RUNTIME_SOURCE
      ? parseRuntimeSource(process.env.PIARIUM_RUNTIME_SOURCE)
      : undefined);
  return {
    ...(packageRoot === undefined || packageRoot.trim() === "" ? {} : { packageRoot }),
    ...(runtimeSource === undefined ? {} : { runtimeSource }),
  };
}
