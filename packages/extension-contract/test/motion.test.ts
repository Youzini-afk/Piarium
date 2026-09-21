import assert from "node:assert/strict";
import test from "node:test";
import {
  VARIN_TRANSITION_SCENE_DATA_CONTRACT,
  VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
  VarinTransitionSceneContractError,
  parseVarinTransitionSceneContributionData,
  varinTransitionSceneDuration,
} from "../src/index.js";

const data = () => ({
  contract: VARIN_TRANSITION_SCENE_DATA_CONTRACT,
  durations: {
    [VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE]: {
      covering: { quick: 900, reduced: 0, standard: 1_800 },
      revealing: { quick: 700, reduced: 0, standard: 1_400 },
    },
  },
  fallback: true,
  scenes: [VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE],
});

test("parses transition scene data without imposing a maximum duration", () => {
  const source = data();
  source.durations[VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE].revealing.standard = 86_400_000;
  const parsed = parseVarinTransitionSceneContributionData(source);
  assert.equal(parsed.fallback, true);
  assert.equal(parsed.durations[VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE].revealing.standard, 86_400_000);
});

test("zero duration explicitly represents an immediate transition", () => {
  const parsed = parseVarinTransitionSceneContributionData(data());
  assert.equal(varinTransitionSceneDuration(parsed, {
    phase: "covering",
    reducedMotion: true,
    scene: VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
    tempo: "standard",
  }), 0);
});

test("selects the declared phase and tempo duration", () => {
  const parsed = parseVarinTransitionSceneContributionData(data());
  assert.equal(varinTransitionSceneDuration(parsed, {
    phase: "revealing",
    reducedMotion: false,
    scene: VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
    tempo: "quick",
  }), 700);
});

test("rejects malformed, negative, duplicate, and unsupported scene data", () => {
  assert.throws(() => parseVarinTransitionSceneContributionData({
    contract: "wrong",
    durations: {
      [VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE]: {
        covering: { quick: -1, reduced: 0, standard: 1 },
        revealing: { quick: 1, reduced: 0, standard: 1 },
      },
    },
    scenes: [VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE, VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE, "future"],
  }), (error: unknown) => (
    error instanceof VarinTransitionSceneContractError
    && error.issues.some((issue) => issue.includes("data.contract"))
    && error.issues.some((issue) => issue.includes("non-negative safe integer"))
    && error.issues.some((issue) => issue.includes("duplicate scene"))
    && error.issues.some((issue) => issue.includes("unsupported"))
  ));
});

