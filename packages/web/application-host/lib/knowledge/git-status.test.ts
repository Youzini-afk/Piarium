import { describe, expect, it } from "vitest";
import { projectGitStatusObservation } from "./git-status.js";

describe("Git status observation projection", () => {
  it("projects both Git route shapes without retaining file details", () => {
    expect(projectGitStatusObservation({
      current: "main",
      files: [{ path: "a.ts" }, { path: "secret.txt" }],
      ahead: 2,
      behind: 1,
      mergeInProgress: { head: "abc" },
    })).toEqual({ branch: "main", changed: 2, note: "2 ahead, 1 behind, merge in progress" });
    expect(projectGitStatusObservation({ isGitRepository: true, branch: "feature", files: [] })).toEqual({
      branch: "feature",
      changed: 0,
    });
  });

  it("keeps not-a-repository and malformed payloads absent", () => {
    expect(projectGitStatusObservation({ isGitRepository: false, files: [] })).toBeNull();
    expect(projectGitStatusObservation(null)).toBeNull();
  });
});
