import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData, JsonValue } from "@piarium/protocol";

type EventEmitter = <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

export const PERMISSION_SYSTEM_STATUS_CHANNEL = "pi-permission-system/status/v1";

const READY_CHANNEL = "permissions:ready";
const UI_PROMPT_CHANNEL = "permissions:ui_prompt";
const DECISION_CHANNEL = "permissions:decision";

interface PermissionPromptSnapshot {
  agentName: string | null;
  forwarding: {
    requesterAgentName: string | null;
    requesterSessionId: string | null;
  } | null;
  requestId: string;
  source: string;
  surface: string | null;
  value: string | null;
}

interface PermissionDecisionSnapshot {
  agentName: string | null;
  matchedPattern: string | null;
  origin: string | null;
  requestId: string;
  resolution: string;
  result: "allow" | "deny";
  surface: string;
  value: string;
}

interface PermissionSystemStatusSnapshot {
  adjudicatesLocally: boolean;
  lastDecision: PermissionDecisionSnapshot | null;
  pending: PermissionPromptSnapshot[];
  ready: boolean;
  version: 1;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const stringOrNull = (value: unknown): string | null => (
  typeof value === "string" ? value : null
);

const parseForwarding = (value: unknown): PermissionPromptSnapshot["forwarding"] => {
  const record = asRecord(value);
  if (!record) return null;
  return {
    requesterAgentName: stringOrNull(record.requesterAgentName),
    requesterSessionId: stringOrNull(record.requesterSessionId),
  };
};

const parsePrompt = (value: unknown): PermissionPromptSnapshot | null => {
  const record = asRecord(value);
  if (!record || typeof record.requestId !== "string" || typeof record.source !== "string") return null;
  return {
    agentName: stringOrNull(record.agentName),
    forwarding: parseForwarding(record.forwarding),
    requestId: record.requestId,
    source: record.source,
    surface: stringOrNull(record.surface),
    value: stringOrNull(record.value),
  };
};

const parseDecision = (value: unknown): PermissionDecisionSnapshot | null => {
  const record = asRecord(value);
  if (
    !record
    || typeof record.requestId !== "string"
    || typeof record.resolution !== "string"
    || (record.result !== "allow" && record.result !== "deny")
    || typeof record.surface !== "string"
    || typeof record.value !== "string"
  ) return null;
  return {
    agentName: stringOrNull(record.agentName),
    matchedPattern: stringOrNull(record.matchedPattern),
    origin: stringOrNull(record.origin),
    requestId: record.requestId,
    resolution: record.resolution,
    result: record.result,
    surface: record.surface,
    value: record.value,
  };
};

/**
 * Projects the permission extension's public EventBus contract into one
 * session-scoped, JSON-safe snapshot. The permission extension remains the
 * sole owner of policy evaluation and of the approval response path.
 */
export function createPermissionSystemStateBridgeExtension(emit: EventEmitter): ExtensionFactory {
  return (pi) => {
    let sessionId: string | undefined;
    let ready = false;
    let adjudicatesLocally = false;
    let lastDecision: PermissionDecisionSnapshot | null = null;
    let stagedReady: { adjudicatesLocally: boolean; sessionId: string | null } | null = null;
    const pending = new Map<string, PermissionPromptSnapshot>();

    const snapshot = (): PermissionSystemStatusSnapshot => ({
      adjudicatesLocally,
      lastDecision,
      pending: [...pending.values()],
      ready,
      version: 1,
    });

    const publish = (): void => {
      if (!sessionId) return;
      emit("extension.state", {
        channel: PERMISSION_SYSTEM_STATUS_CHANNEL,
        sessionId,
        value: snapshot() as unknown as JsonValue,
      });
    };

    const unsubscribers = [
      pi.events.on(READY_CHANNEL, (value) => {
        const record = asRecord(value);
        if (!record || typeof record.adjudicatesLocally !== "boolean") return;
        const announcedSessionId = stringOrNull(record.sessionId);
        if (!sessionId) {
          stagedReady = {
            adjudicatesLocally: record.adjudicatesLocally,
            sessionId: announcedSessionId,
          };
          return;
        }
        if (sessionId && announcedSessionId && announcedSessionId !== sessionId) return;
        ready = true;
        adjudicatesLocally = record.adjudicatesLocally;
        publish();
      }),
      pi.events.on(UI_PROMPT_CHANNEL, (value) => {
        const prompt = parsePrompt(value);
        if (!prompt) return;
        ready = true;
        pending.set(prompt.requestId, prompt);
        publish();
      }),
      pi.events.on(DECISION_CHANNEL, (value) => {
        const decision = parseDecision(value);
        if (!decision) return;
        ready = true;
        pending.delete(decision.requestId);
        lastDecision = decision;
        publish();
      }),
    ];

    pi.on("session_start", (_event, context) => {
      sessionId = context.sessionManager.getSessionId();
      if (stagedReady && (!stagedReady.sessionId || stagedReady.sessionId === sessionId)) {
        ready = true;
        adjudicatesLocally = stagedReady.adjudicatesLocally;
        publish();
      }
      stagedReady = null;
    });

    pi.on("session_shutdown", () => {
      const closingSessionId = sessionId;
      sessionId = undefined;
      stagedReady = null;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      pending.clear();
      if (!closingSessionId) return;
      emit("extension.state", {
        channel: PERMISSION_SYSTEM_STATUS_CHANNEL,
        sessionId: closingSessionId,
        value: null,
      });
    });
  };
}
