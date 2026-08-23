import assert from "node:assert/strict";
import test from "node:test";
import {
  PIARIUM_TRANSITION_SCENE_DATA_CONTRACT,
  PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
  PiariumTransitionSceneContractError,
  parsePiariumTransitionSceneContributionData,
  piariumTransitionSceneDuration,
} from "../src/index.js";

const data = () => ({
  contract: PIARIUM_TRANSITION_SCENE_DATA_CONTRACT,
  durations: {
    [PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE]: {
      covering: { quick: 900, reduced: 0, standard: 1_800 },
      revealing: { quick: 700, reduced: 0, standard: 1_400 },
    },
  },
  fallback: true,
  scenes: [PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE],
});

test("parses transition scene data without imposing a maximum duration", () => {
  const source = data();
  source.durations[PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE].revealing.standard = 86_400_000;
  const parsed = parsePiariumTransitionSceneContributionData(source);
  assert.equal(parsed.fallback, true);
  assert.equal(parsed.durations[PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE].revealing.standard, 86_400_000);
});

test("zero duration explicitly represents an immediate transition", () => {
  const parsed = parsePiariumTransitionSceneContributionData(data());
  assert.equal(piariumTransitionSceneDuration(parsed, {
    phase: "covering",
    reducedMotion: true,
    scene: PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
    tempo: "standard",
  }), 0);
});

test("selects the declared phase and tempo duration", () => {
  const parsed = parsePiariumTransitionSceneContributionData(data());
  assert.equal(piariumTransitionSceneDuration(parsed, {
    phase: "revealing",
    reducedMotion: false,
    scene: PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
    tempo: "quick",
  }), 700);
});

test("rejects malformed, negative, duplicate, and unsupported scene data", () => {
  assert.throws(() => parsePiariumTransitionSceneContributionData({
    contract: "wrong",
    durations: {
      [PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE]: {
        covering: { quick: -1, reduced: 0, standard: 1 },
        revealing: { quick: 1, reduced: 0, standard: 1 },
      },
    },
    scenes: [PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE, PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE, "future"],
  }), (error: unknown) => (
    error instanceof PiariumTransitionSceneContractError
    && error.issues.some((issue) => issue.includes("data.contract"))
    && error.issues.some((issue) => issue.includes("non-negative safe integer"))
    && error.issues.some((issue) => issue.includes("duplicate scene"))
    && error.issues.some((issue) => issue.includes("unsupported"))
  ));
});

