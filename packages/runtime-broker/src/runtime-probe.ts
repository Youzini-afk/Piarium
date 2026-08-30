import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostHandshakeResult, RuntimeSourceKind } from "@piarium/protocol";
import { assertPiSdkResolvable } from "@piarium/pi-host/sdk";
import { assertExternalPiHostEntry, piRuntimeIssueCodeFromError } from "./errors.js";
import { PiHostClient } from "./host-client.js";

export interface PiRuntimeProbeOptions {
  agentDir?: string;
  createSession?: boolean;
  hostEntry: string;
  nodePath?: string;
  packageRoot?: string;
  runtimeSource?: RuntimeSourceKind;
}

export interface PiRuntimeProbeResult {
  handshake: HostHandshakeResult;
  sessionCreated: boolean;
}

function formatProbeError(error: unknown, stderr: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const detail = [message, stderr.trim()].filter(Boolean).join("\n");
  const formatted = new Error(detail, { cause: error });
  const issueCode = piRuntimeIssueCodeFromError(error);
  if (issueCode) Object.assign(formatted, { code: issueCode });
  return formatted;
}

export async function probePiRuntime(options: PiRuntimeProbeOptions): Promise<PiRuntimeProbeResult> {
  assertExternalPiHostEntry(options.hostEntry);
  if (options.packageRoot) {
    try {
      assertPiSdkResolvable(options.packageRoot);
    } catch (error) {
      throw formatProbeError(error, "");
    }
  }

  const diagnostics: string[] = [];
  const client = new PiHostClient({
    ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
    handshake: {
      clientName: "piarium-runtime-probe",
      clientVersion: "0.1.0",
      mode: "test",
    },
    hostEntry: options.hostEntry,
    ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
    onDiagnostic: (_level, message) => {
      diagnostics.push(message);
    },
    ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    projectTrustOverride: true,
    ...(options.runtimeSource === undefined ? {} : { runtimeSource: options.runtimeSource }),
  });

  let workspace: string | undefined;
  try {
    const handshake = await client.start();
    let sessionCreated = false;
    if (options.createSession) {
      workspace = await mkdtemp(join(tmpdir(), "piarium-runtime-probe-"));
      await client.request("session.create", { cwd: workspace });
      sessionCreated = true;
    }
    return { handshake, sessionCreated };
  } catch (error) {
    throw formatProbeError(error, diagnostics.join(""));
  } finally {
    await client.dispose();
    if (workspace) await rm(workspace, { force: true, recursive: true });
  }
}
