export declare const PIARIUM_SESSION_FEATURES_SCHEMA_VERSION: 1;
export type PiSessionGoalStatus = "active" | "paused" | "blocked" | "budgetLimited" | "complete";
export interface PiSessionGoalState {
    auditFailStreak: number;
    blockedStreak: number;
    createdAt: number;
    evaluationModel?: string;
    evaluationProvider?: string;
    id: string;
    lastEvaluatedEntryId?: string;
    note?: string;
    objective: string;
    status: PiSessionGoalStatus;
    statusReason?: string;
    tokenBaseline: number;
    tokenBudget?: number;
    tokensUsed: number;
    turnsUsed: number;
    updatedAt: number;
}
export interface PiSessionAssistState {
    evaluationModel?: string;
    evaluationProvider?: string;
    forEntryId: string;
    generatedAt: number;
    recap?: string;
    suggestion?: string;
}
export interface PiSessionFeatureState {
    assist?: PiSessionAssistState;
    goal?: PiSessionGoalState;
    revision: number;
    schemaVersion: typeof PIARIUM_SESSION_FEATURES_SCHEMA_VERSION;
}
export type PiSessionFeatureMutation = {
    objective: string;
    tokenBudget?: number;
    type: "goal.start";
} | {
    auditFailStreak?: number;
    blockedStreak?: number;
    evaluationModel?: string;
    evaluationProvider?: string;
    goalId: string;
    lastEvaluatedEntryId?: string;
    note?: string;
    status?: PiSessionGoalStatus;
    statusReason?: string;
    tokensUsed?: number;
    turnsUsed?: number;
    type: "goal.update";
} | {
    goalId?: string;
    type: "goal.clear";
} | {
    evaluationModel?: string;
    evaluationProvider?: string;
    forEntryId: string;
    generatedAt?: number;
    recap?: string;
    suggestion?: string;
    type: "assist.set";
} | {
    field?: "all" | "recap" | "suggestion";
    forEntryId?: string;
    type: "assist.clear";
};
export declare class PiSessionFeatureValidationError extends Error {
    constructor(message: string);
}
export declare function parsePiSessionFeatureMutation(value: unknown): PiSessionFeatureMutation;
//# sourceMappingURL=session-features.d.ts.map