import { expect, it } from "vitest";
import type { PiSettingsSnapshot } from "@piarium/protocol";
import { resolveThreadWorktreeSettings } from "./thread-worktree-settings.js";

const snapshot = (projectTrusted: boolean): PiSettingsSnapshot => ({
  globalRevision: "global-revision", projectRevision: "project-revision", projectTrusted,
  global: { harness: { worktree: { setup: "user-setup", reclaimIdle: false, budget: { maxBytes: 1000 } } } },
  project: { harness: { worktree: { setup: "project-setup", copyIgnored: [".env.local"], budget: { minFreeRatio: 0.2 } } } },
});

it("uses project setup only after Pi trusts that project and preserves explicit user choices", () => {
  expect(resolveThreadWorktreeSettings(snapshot(false))).toMatchObject({ setup: "user-setup", reclaimIdle: false, copyIgnored: [], budget: { maxBytes: 1000 } });
  expect(resolveThreadWorktreeSettings(snapshot(true))).toMatchObject({ setup: "project-setup", reclaimIdle: false, copyIgnored: [".env.local"], budget: { maxBytes: 1000, minFreeRatio: 0.2 } });
});

it("does not turn malformed authorized settings into a successful default", () => {
  const invalid = snapshot(true);
  invalid.project = { harness: { worktree: { setup: ["not a command"] } } };
  expect(() => resolveThreadWorktreeSettings(invalid)).toThrow("setup must be a command string");
  expect(resolveThreadWorktreeSettings({ ...invalid, projectTrusted: false })?.setup).toBe("user-setup");
});

it("keeps the normal default when settings are genuinely absent", () => {
  expect(resolveThreadWorktreeSettings({ ...snapshot(false), global: {}, project: {} })).toMatchObject({ reclaimIdle: true, shareDependencies: false, copyIgnored: [] });
});
