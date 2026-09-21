/**
 * TypeSafe System One wire adapter for the Fast Decision capability (D-312).
 * This is not chat completion and not an HTTP rerank endpoint.
 *
 * POST {baseUrl}{endpoint}   (default endpoint /v1/systemone)
 * Authorization: Bearer <key>
 * {
 *   model, state,
 *   questions: { <id>: { type: "noul"|"choice"|"score", instructions, criteria } }
 * }
 * {
 *   model,
 *   answers: { <id>: noul | choice | score answer },
 *   usage: { input_tokens, output_tokens }
 * }
 *
 * The adapter owns the Jev-native primitives; callers pass vendor-neutral
 * FastDecisionQuestion values. A missing or malformed answer lands in
 * `missing` — never reinterpreted as false or zero.
 */
import type {
  FastDecisionAnswer,
  FastDecisionInstructions,
  FastDecisionQuestion,
} from "@varin/protocol";

export const SYSTEMONE_DEFAULT_ENDPOINT = "/v1/systemone";
/** Criteria key used when the caller asks for an explicit "no suitable option". */
const NONE_OPTION = "__none__";

export interface SystemoneRequest {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  endpoint?: string;
  model: string;
  /** Provider state value: string, object, or array. */
  state: unknown;
  questions: readonly FastDecisionQuestion[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface SystemoneResponse {
  /** Versioned model reported by the provider, when it differs from the alias sent. */
  servedModelId?: string;
  answers: FastDecisionAnswer[];
  /** Question ids the provider skipped or answered invalidly. */
  missing: string[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

export class SystemoneRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemoneRequestError";
  }
}

export class SystemoneResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemoneResponseError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const finiteNumber = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isFinite(value) ? value : undefined
);

const probabilities = (value: unknown): Record<string, number> | null | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const n = finiteNumber(entry);
    if (n === undefined || n < 0 || n > 1) return null;
    out[key] = n;
  }
  return out;
};

const instructionsOf = (question: FastDecisionQuestion): FastDecisionInstructions => question.instructions;

function wireQuestion(question: FastDecisionQuestion): Record<string, unknown> {
  switch (question.kind) {
    case "judge":
      return {
        type: "noul",
        instructions: instructionsOf(question),
        ...(question.criteria
          ? { criteria: { true: question.criteria.yes ?? "yes", false: question.criteria.no ?? "no" } }
          : {}),
      };
    case "choose": {
      if (question.options.length === 0 || question.options.length > 255) {
        throw new SystemoneRequestError(`choose question ${question.id} needs 1..255 options`);
      }
      const criteria: Record<string, unknown> = {};
      for (const option of question.options) {
        if (option.id === NONE_OPTION) {
          throw new SystemoneRequestError(`choose question ${question.id} uses the reserved option id`);
        }
        if (Object.hasOwn(criteria, option.id)) {
          throw new SystemoneRequestError(`choose question ${question.id} has a duplicate option id`);
        }
        criteria[option.id] = option.detail ?? null;
      }
      if (question.allowNone) {
        criteria[NONE_OPTION] = "None of the options fits the question.";
      }
      return { type: "choice", instructions: instructionsOf(question), criteria };
    }
    case "score": {
      if (question.levels.length < 2 || question.levels.length > 10) {
        throw new SystemoneRequestError(`score question ${question.id} needs 2..10 rubric levels`);
      }
      return { type: "score", instructions: instructionsOf(question), criteria: [...question.levels] };
    }
  }
}

function readAnswer(question: FastDecisionQuestion, raw: unknown): FastDecisionAnswer | undefined {
  if (!isRecord(raw)) return undefined;
  switch (question.kind) {
    case "judge": {
      if (raw.type !== "noul") return undefined;
      const value = finiteNumber(raw.noul);
      if (value === undefined || value < 0 || value > 1) return undefined;
      return { id: question.id, kind: "judge", value };
    }
    case "choose": {
      if (raw.type !== "choice") return undefined;
      const choice = raw.choice;
      if (typeof choice !== "string") return undefined;
      const valid = choice === NONE_OPTION
        ? Boolean(question.allowNone)
        : question.options.some((option) => option.id === choice);
      if (!valid) return undefined;
      const probs = probabilities(raw.probabilities);
      if (probs === null) return undefined;
      if (probs && Object.keys(probs).some((key) => (
        key !== NONE_OPTION && !question.options.some((option) => option.id === key)
      ))) return undefined;
      const confidence = finiteNumber(raw.confidence);
      if (raw.confidence !== undefined && (confidence === undefined || confidence < 0 || confidence > 1)) return undefined;
      return {
        id: question.id,
        kind: "choose",
        choice: choice === NONE_OPTION ? null : choice,
        ...(probs ? { probabilities: probs } : {}),
        ...(confidence === undefined ? {} : { confidence }),
      };
    }
    case "score": {
      if (raw.type !== "score") return undefined;
      const score = finiteNumber(raw.score);
      if (score === undefined || score < 0 || score > question.levels.length - 1) return undefined;
      const probs = probabilities(raw.probabilities);
      if (probs === null) return undefined;
      if (probs && Object.keys(probs).some((key) => {
        const level = Number(key);
        return !Number.isInteger(level) || level < 0 || level >= question.levels.length;
      })) return undefined;
      const confidence = finiteNumber(raw.confidence);
      if (raw.confidence !== undefined && (confidence === undefined || confidence < 0 || confidence > 1)) return undefined;
      return {
        id: question.id,
        kind: "score",
        score,
        ...(probs ? { probabilities: probs } : {}),
        ...(confidence === undefined ? {} : { confidence }),
      };
    }
  }
}

export async function requestSystemone(request: SystemoneRequest): Promise<SystemoneResponse> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const endpoint = request.endpoint ?? SYSTEMONE_DEFAULT_ENDPOINT;
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const questions: Record<string, unknown> = {};
  for (const question of request.questions) {
    if (Object.hasOwn(questions, question.id)) {
      throw new SystemoneRequestError(`duplicate question id ${question.id}`);
    }
    questions[question.id] = wireQuestion(question);
  }
  const response = await fetchImpl(`${request.baseUrl.replace(/\/+$/u, "")}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`,
      ...request.headers,
    },
    body: JSON.stringify({ model: request.model, state: request.state, questions }),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!response.ok) {
    throw new SystemoneResponseError(`Systemone HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    throw new SystemoneResponseError("Systemone response is missing answers");
  }
  const answers: FastDecisionAnswer[] = [];
  const missing: string[] = [];
  for (const question of request.questions) {
    const parsed = readAnswer(question, payload.answers[question.id]);
    if (parsed) answers.push(parsed);
    else missing.push(question.id);
  }
  const inputTokens = isRecord(payload.usage) ? finiteNumber(payload.usage.input_tokens) : undefined;
  const outputTokens = isRecord(payload.usage) ? finiteNumber(payload.usage.output_tokens) : undefined;
  const usage = inputTokens !== undefined || outputTokens !== undefined
    ? {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      }
    : undefined;
  const served = typeof payload.model === "string" && payload.model && payload.model !== request.model
    ? payload.model
    : undefined;
  return {
    ...(served ? { servedModelId: served } : {}),
    answers,
    missing,
    ...(usage ? { usage } : {}),
  };
}
