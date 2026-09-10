import { describe, expect, it } from "vitest";
import {
  HarnessShellSettingsError,
  resolveHarnessShellSetting,
} from "./harness-shell-settings.js";
import type { JsonValue, PiSettingsSnapshot } from "@piarium/protocol";

const snapshot = (
  global: { [key: string]: JsonValue },
  project: { [key: string]: JsonValue } = {},
  projectTrusted = false,
): PiSettingsSnapshot => ({
  global,
  globalRevision: "g1",
  project,
  projectRevision: "p1",
  projectTrusted,
});

describe("resolveHarnessShellSetting", () => {
  it("defaults to auto when neither file sets harness.shell", () => {
    expect(resolveHarnessShellSetting(snapshot({}))).toBe("auto");
  });

  it("uses the user setting when the project is not trusted", () => {
    expect(resolveHarnessShellSetting(snapshot(
      { harness: { shell: "powershell" } },
      { harness: { shell: "wsl" } },
      false,
    ))).toBe("powershell");
  });

  it("lets a trusted project override the user shell", () => {
    expect(resolveHarnessShellSetting(snapshot(
      { harness: { shell: "powershell" } },
      { harness: { shell: "wsl" } },
      true,
    ))).toBe("wsl");
  });

  it("rejects an unknown shell instead of treating it as auto", () => {
    expect(() => resolveHarnessShellSetting(snapshot({ harness: { shell: "cmd" } }))).toThrow(HarnessShellSettingsError);
  });
});
