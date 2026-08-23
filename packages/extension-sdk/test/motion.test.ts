import assert from "node:assert/strict";
import test from "node:test";
import {
  PIARIUM_TRANSITION_SCENE_CONTRACT_VERSION,
  PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
  defineTransitionSceneMount,
  type PiariumTransitionSceneFrameV1,
} from "../src/index.js";

test("defines a framework-neutral transition scene mount without changing its implementation", () => {
  const frame: PiariumTransitionSceneFrameV1 = {
    contractVersion: PIARIUM_TRANSITION_SCENE_CONTRACT_VERSION,
    direction: "forward",
    fromProfileId: "default",
    phase: "covering",
    reducedMotion: false,
    scene: PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
    tempo: "quick",
    toProfileId: "piarium.ide",
    transitionId: 7,
  };
  const implementation = defineTransitionSceneMount((_container, context) => {
    assert.equal(context.props.transition.getSnapshot(), frame);
  });
  assert.equal(typeof implementation.mount, "function");
});
