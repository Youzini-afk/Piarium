export const VARIN_TRANSITION_SCENE_DATA_CONTRACT = "varin-transition-scene/v1" as const;
export const VARIN_TRANSITION_SCENE_CONTRACT_VERSION = 1 as const;
export const VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE = "workbench-profile" as const;
export const VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION_ID = "varin.builtin.transition-scene" as const;
export const VARIN_BUILTIN_TRANSITION_SCENE_CONTRIBUTION_ID = "varin.builtin.transition-scene.default" as const;

export type VarinTransitionSceneId = typeof VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE;
export type VarinTransitionSceneDirection = "backward" | "forward";
export type VarinTransitionScenePhase = "covered" | "covering" | "revealing";
export type VarinTransitionSceneAnimatedPhase = Exclude<VarinTransitionScenePhase, "covered">;
export type VarinTransitionSceneTempo = "quick" | "standard";

export interface VarinTransitionSceneDurationSet {
  quick: number;
  reduced: number;
  standard: number;
}

export interface VarinTransitionScenePhaseDurations {
  covering: VarinTransitionSceneDurationSet;
  revealing: VarinTransitionSceneDurationSet;
}

export interface VarinTransitionSceneContributionDataV1 {
  contract: typeof VARIN_TRANSITION_SCENE_DATA_CONTRACT;
  durations: Record<VarinTransitionSceneId, VarinTransitionScenePhaseDurations>;
  fallback?: boolean;
  scenes: VarinTransitionSceneId[];
}

export interface VarinTransitionSceneFrameV1 {
  contractVersion: typeof VARIN_TRANSITION_SCENE_CONTRACT_VERSION;
  direction: VarinTransitionSceneDirection;
  fromProfileId: string | null;
  phase: VarinTransitionScenePhase;
  reducedMotion: boolean;
  scene: VarinTransitionSceneId;
  tempo: VarinTransitionSceneTempo;
  toProfileId: string;
  transitionId: number;
}

export class VarinTransitionSceneContractError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[]) {
    super(message);
    this.name = "VarinTransitionSceneContractError";
    this.issues = [...issues];
  }
}

const record = (value: unknown): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const duration = (value: unknown, path: string, issues: string[]): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    issues.push(`${path} must be a non-negative safe integer`);
    return 0;
  }
  return Number(value);
};

const durationSet = (
  value: unknown,
  path: string,
  issues: string[],
): VarinTransitionSceneDurationSet => {
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

const phaseDurations = (
  value: unknown,
  path: string,
  issues: string[],
): VarinTransitionScenePhaseDurations => {
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

export const parseVarinTransitionSceneContributionData = (
  value: unknown,
): VarinTransitionSceneContributionDataV1 => {
  const issues: string[] = [];
  const source = record(value);
  if (!source) {
    throw new VarinTransitionSceneContractError(
      "Varin transition scene contribution data is invalid",
      ["data must be an object"],
    );
  }
  if (source.contract !== VARIN_TRANSITION_SCENE_DATA_CONTRACT) {
    issues.push(`data.contract must be ${VARIN_TRANSITION_SCENE_DATA_CONTRACT}`);
  }
  const rawScenes = Array.isArray(source.scenes) ? source.scenes : [];
  if (!Array.isArray(source.scenes)) issues.push("data.scenes must be an array");
  const scenes: VarinTransitionSceneId[] = [];
  const seen = new Set<string>();
  for (const [index, rawScene] of rawScenes.entries()) {
    if (rawScene !== VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE) {
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
  if (scenes.length === 0) issues.push("data.scenes must contain at least one supported scene");

  const rawDurations = record(source.durations);
  if (!rawDurations) issues.push("data.durations must be an object");
  const workbenchProfile = phaseDurations(
    rawDurations?.[VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE],
    `data.durations.${VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE}`,
    issues,
  );
  if (source.fallback !== undefined && typeof source.fallback !== "boolean") {
    issues.push("data.fallback must be a boolean");
  }
  if (issues.length > 0) {
    throw new VarinTransitionSceneContractError(
      "Varin transition scene contribution data is invalid",
      issues,
    );
  }
  return {
    contract: VARIN_TRANSITION_SCENE_DATA_CONTRACT,
    durations: { [VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE]: workbenchProfile },
    ...(typeof source.fallback === "boolean" ? { fallback: source.fallback } : {}),
    scenes,
  };
};

export const varinTransitionSceneDuration = (
  data: VarinTransitionSceneContributionDataV1,
  input: {
    phase: VarinTransitionSceneAnimatedPhase;
    reducedMotion: boolean;
    scene: VarinTransitionSceneId;
    tempo: VarinTransitionSceneTempo;
  },
): number => {
  const timings = data.durations[input.scene][input.phase];
  return input.reducedMotion ? timings.reduced : timings[input.tempo];
};
