export const PIARIUM_TRANSITION_SCENE_DATA_CONTRACT = "piarium-transition-scene/v1";
export const PIARIUM_TRANSITION_SCENE_CONTRACT_VERSION = 1;
export const PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE = "workbench-profile";
export const PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION_ID = "piarium.builtin.transition-scene";
export const PIARIUM_BUILTIN_TRANSITION_SCENE_CONTRIBUTION_ID = "piarium.builtin.transition-scene.default";
export class PiariumTransitionSceneContractError extends Error {
    issues;
    constructor(message, issues) {
        super(message);
        this.name = "PiariumTransitionSceneContractError";
        this.issues = [...issues];
    }
}
const record = (value) => (typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null);
const duration = (value, path, issues) => {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        issues.push(`${path} must be a non-negative safe integer`);
        return 0;
    }
    return Number(value);
};
const durationSet = (value, path, issues) => {
    const source = record(value);
    if (!source) {
        issues.push(`${path} must be an object`);
        return { quick: 0, reduced: 0, standard: 0 };
    }
    return {
        quick: duration(source.quick, `${path}.quick`, issues),
        reduced: duration(source.reduced, `${path}.reduced`, issues),
        standard: duration(source.standard, `${path}.standard`, issues),
    };
};
const phaseDurations = (value, path, issues) => {
    const source = record(value);
    if (!source) {
        issues.push(`${path} must be an object`);
        return {
            covering: { quick: 0, reduced: 0, standard: 0 },
            revealing: { quick: 0, reduced: 0, standard: 0 },
        };
    }
    return {
        covering: durationSet(source.covering, `${path}.covering`, issues),
        revealing: durationSet(source.revealing, `${path}.revealing`, issues),
    };
};
export const parsePiariumTransitionSceneContributionData = (value) => {
    const issues = [];
    const source = record(value);
    if (!source) {
        throw new PiariumTransitionSceneContractError("Piarium transition scene contribution data is invalid", ["data must be an object"]);
    }
    if (source.contract !== PIARIUM_TRANSITION_SCENE_DATA_CONTRACT) {
        issues.push(`data.contract must be ${PIARIUM_TRANSITION_SCENE_DATA_CONTRACT}`);
    }
    const rawScenes = Array.isArray(source.scenes) ? source.scenes : [];
    if (!Array.isArray(source.scenes))
        issues.push("data.scenes must be an array");
    const scenes = [];
    const seen = new Set();
    for (const [index, rawScene] of rawScenes.entries()) {
        if (rawScene !== PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE) {
            issues.push(`data.scenes[${index}] is unsupported`);
            continue;
        }
        if (seen.has(rawScene)) {
            issues.push(`data.scenes contains duplicate scene ${rawScene}`);
            continue;
        }
        seen.add(rawScene);
        scenes.push(rawScene);
    }
    if (scenes.length === 0)
        issues.push("data.scenes must contain at least one supported scene");
    const rawDurations = record(source.durations);
    if (!rawDurations)
        issues.push("data.durations must be an object");
    const workbenchProfile = phaseDurations(rawDurations?.[PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE], `data.durations.${PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE}`, issues);
    if (source.fallback !== undefined && typeof source.fallback !== "boolean") {
        issues.push("data.fallback must be a boolean");
    }
    if (issues.length > 0) {
        throw new PiariumTransitionSceneContractError("Piarium transition scene contribution data is invalid", issues);
    }
    return {
        contract: PIARIUM_TRANSITION_SCENE_DATA_CONTRACT,
        durations: { [PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE]: workbenchProfile },
        ...(typeof source.fallback === "boolean" ? { fallback: source.fallback } : {}),
        scenes,
    };
};
export const piariumTransitionSceneDuration = (data, input) => {
    const timings = data.durations[input.scene][input.phase];
    return input.reducedMotion ? timings.reduced : timings[input.tempo];
};
//# sourceMappingURL=motion.js.map