import type { PiRuntimeInstallPlan, PiRuntimeInstallation } from "@piarium/protocol";
import {
  compareVersions,
  detectOwningPackageManager,
  detectPackageManagers,
  findCommands,
  globalInstallArguments,
  inferGlobalPrefix,
  type DetectedPackageManager,
  type PiPackageManagerKind,
} from "@piarium/pi-host/discovery";
import { standaloneRuntimeLocations } from "./standalone-runtime.js";

export const PI_INSTALL_PACKAGE = "@earendil-works/pi-coding-agent";

export interface PlanPiInstallOptions {
  current?: Pick<PiRuntimeInstallation, "commandPath" | "packageRoot" | "version">;
  env?: NodeJS.ProcessEnv;
  findCommands?: typeof findCommands;
  managers?: DetectedPackageManager[];
  platform?: NodeJS.Platform;
  runner?: (command: string, args: string[]) => Promise<{ exitCode: number; stderr: string; stdout: string }>;
  standaloneAvailable?: boolean;
  targetVersion: string;
}

function packageSpec(version: string): string {
  return `${PI_INSTALL_PACKAGE}@${version}`;
}

function selectManager(
  current: PlanPiInstallOptions["current"],
  managers: DetectedPackageManager[],
): DetectedPackageManager | undefined {
  const owning = detectOwningPackageManager([current?.commandPath, current?.packageRoot]);
  if (owning) {
    const match = managers.find((manager) => manager.kind === owning);
    if (match) return match;
  }
  return managers[0];
}

export function planPiInstall(options: PlanPiInstallOptions): PiRuntimeInstallPlan {
  const currentVersion = options.current?.version;
  const managers = options.managers ?? [];
  const selected = selectManager(options.current, managers);
  const standalone = standaloneRuntimeLocations(options.platform, options.env);

  if (currentVersion && compareVersions(currentVersion, options.targetVersion) > 0) {
    return {
      action: "keep-newer",
      currentVersion,
      targetVersion: options.targetVersion,
      reason: `Installed Pi ${currentVersion} is newer than ${options.targetVersion} and will be kept`,
    };
  }
  if (currentVersion && compareVersions(currentVersion, options.targetVersion) === 0) {
    return {
      action: "none",
      currentVersion,
      targetVersion: options.targetVersion,
      reason: `Pi ${currentVersion} is already installed`,
    };
  }

  if (selected) {
    const action = currentVersion ? "upgrade" : "install";
    const location = inferGlobalPrefix(selected.executable, selected.kind);
    return {
      action,
      args: globalInstallArguments(selected.kind, packageSpec(options.targetVersion)),
      ...(currentVersion === undefined ? {} : { currentVersion }),
      executable: selected.executable,
      ...(location === undefined ? {} : { location }),
      manager: selected.kind,
      reason: currentVersion
        ? `Upgrade Pi ${currentVersion} to ${options.targetVersion} with ${selected.kind}`
        : `Install Pi ${options.targetVersion} with ${selected.kind}`,
      targetVersion: options.targetVersion,
    };
  }

  if (options.standaloneAvailable) {
    return {
      action: currentVersion ? "upgrade" : "install",
      ...(currentVersion === undefined ? {} : { currentVersion }),
      location: standalone.runtimeDir,
      manager: "standalone",
      reason: currentVersion
        ? `Upgrade Pi ${currentVersion} to ${options.targetVersion} from the standalone payload`
        : `Install Pi ${options.targetVersion} from the standalone payload`,
      targetVersion: options.targetVersion,
    };
  }

  return {
    action: currentVersion ? "upgrade" : "install",
    ...(currentVersion === undefined ? {} : { currentVersion }),
    reason: currentVersion
      ? "No package manager is available to upgrade Pi"
      : "No package manager or standalone Pi payload is available",
    targetVersion: options.targetVersion,
  };
}

export async function detectInstallManagers(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runner: (command: string, args: string[]) => Promise<{ exitCode: number; stderr: string; stdout: string }>;
}): Promise<DetectedPackageManager[]> {
  const platform = options.platform ?? process.platform;
  return detectPackageManagers({
    ...(options.env === undefined ? {} : { env: options.env }),
    platform,
    findCommands: (name) => findCommands(name, platform, options.runner),
  });
}

export function assertNotDowngrade(currentVersion: string | undefined, targetVersion: string): void {
  if (currentVersion && compareVersions(currentVersion, targetVersion) > 0) {
    throw new Error(`Refusing to install Pi ${targetVersion} over newer ${currentVersion}`);
  }
}

export type { PiPackageManagerKind };
