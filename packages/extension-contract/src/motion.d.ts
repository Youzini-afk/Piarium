export declare const PIARIUM_TRANSITION_SCENE_DATA_CONTRACT: "piarium-transition-scene/v1";
export declare const PIARIUM_TRANSITION_SCENE_CONTRACT_VERSION: 1;
export declare const PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE: "workbench-profile";
export declare const PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION_ID: "piarium.builtin.transition-scene";
export declare const PIARIUM_BUILTIN_TRANSITION_SCENE_CONTRIBUTION_ID: "piarium.builtin.transition-scene.default";
export type PiariumTransitionSceneId = typeof PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE;
export type PiariumTransitionSceneDirection = "backward" | "forward";
export type PiariumTransitionScenePhase = "covered" | "covering" | "revealing";
export type PiariumTransitionSceneAnimatedPhase = Exclude<PiariumTransitionScenePhase, "covered">;
export type PiariumTransitionSceneTempo = "quick" | "standard";
export interface PiariumTransitionSceneDurationSet {
    quick: number;
    reduced: number;
    standard: number;
}
export interface PiariumTransitionScenePhaseDurations {
    covering: PiariumTransitionSceneDurationSet;
    revealing: PiariumTransitionSceneDurationSet;
}
export interface PiariumTransitionSceneContributionDataV1 {
    contract: typeof PIARIUM_TRANSITION_SCENE_DATA_CONTRACT;
    durations: Record<PiariumTransitionSceneId, PiariumTransitionScenePhaseDurations>;
    fallback?: boolean;
    scenes: PiariumTransitionSceneId[];
}
export interface PiariumTransitionSceneFrameV1 {
    contractVersion: typeof PIARIUM_TRANSITION_SCENE_CONTRACT_VERSION;
    direction: PiariumTransitionSceneDirection;
    fromProfileId: string | null;
    phase: PiariumTransitionScenePhase;
    reducedMotion: boolean;
    scene: PiariumTransitionSceneId;
    tempo: PiariumTransitionSceneTempo;
    toProfileId: string;
    transitionId: number;
}
export declare class PiariumTransitionSceneContractError extends Error {
    readonly issues: readonly string[];
    constructor(message: string, issues: readonly string[]);
}
export declare const parsePiariumTransitionSceneContributionData: (value: unknown) => PiariumTransitionSceneContributionDataV1;
export declare const piariumTransitionSceneDuration: (data: PiariumTransitionSceneContributionDataV1, input: {
    phase: PiariumTransitionSceneAnimatedPhase;
    reducedMotion: boolean;
    scene: PiariumTransitionSceneId;
    tempo: PiariumTransitionSceneTempo;
}) => number;
//# sourceMappingURL=motion.d.ts.map