import { mergeHarnessSettings, type HarnessSettings, type PiSettingsSnapshot } from "@piarium/protocol";

export type HarnessShellSetting = HarnessSettings["shell"];

export class HarnessShellSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessShellSettingsError";
  }
}

const SHELL_SETTINGS = ["auto", "git-bash", "powershell", "wsl"] as const;

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HarnessShellSettingsError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const isShellSetting = (value: unknown): value is HarnessShellSetting => (
  typeof value === "string" && (SHELL_SETTINGS as readonly string[]).includes(value)
);

const shellFrom = (value: unknown, label: string): HarnessShellSetting | undefined => {
  const harness = object(object(value, label).harness, `${label}.harness`);
  if (harness.shell === undefined) return undefined;
  if (!isShellSetting(harness.shell)) {
    throw new HarnessShellSettingsError(
      `${label}.harness.shell must be one of: ${SHELL_SETTINGS.join(", ")}`,
    );
  }
  return harness.shell;
};

/**
 * Pi owns settings.json loading and project trust. Host only reads the snapshot
 * already returned by `settings.get`.
 */
export const resolveHarnessShellSetting = (snapshot: PiSettingsSnapshot): HarnessShellSetting => {
  const user = shellFrom(snapshot.global, "global settings");
  const project = snapshot.projectTrusted
    ? shellFrom(snapshot.project, "project settings")
    : undefined;
  return mergeHarnessSettings(
    user === undefined ? {} : { shell: user },
    project === undefined ? {} : { shell: project },
  ).shell;
};
