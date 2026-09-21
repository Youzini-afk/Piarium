import assert from "node:assert/strict";
import test from "node:test";
import {
  VARIN_TRANSITION_SCENE_CONTRACT_VERSION,
  VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
  defineTransitionSceneMount,
  type VarinTransitionSceneFrameV1,
} from "../src/index.js";

test("defines a framework-neutral transition scene mount without changing its implementation", () => {
  const frame: VarinTransitionSceneFrameV1 = {
    contractVersion: VARIN_TRANSITION_SCENE_CONTRACT_VERSION,
    direction: "forward",
    fromProfileId: "default",
    phase: "covering",
    reducedMotion: false,
    scene: VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
    tempo: "quick",
    toProfileId: "varin.ide",
    transitionId: 7,
  };
  const implementation = defineTransitionSceneMount((_container, context) => {
    assert.equal(context.props.transition.getSnapshot(), frame);
  });
  assert.equal(typeof implementation.mount, "function");
});
