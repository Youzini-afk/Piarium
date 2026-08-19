export type FleetUiRequestIdentity = {
  generation: number;
  runtimeKey: string;
  sessionId: string;
  targetKey: string;
};

export type FleetUiCurrentIdentity = {
  generation: number;
  runtimeKey: string;
  sessionId: string | null;
  targetKey: string | null;
};

export const fleetSessionTargetKey = (runtimeKey: string, sessionId: string): string => (
  `${runtimeKey}:session:${sessionId}`
);

export const fleetUiRequestIsCurrent = (
  captured: FleetUiRequestIdentity,
  current: FleetUiCurrentIdentity,
): boolean => (
  current.sessionId !== null
  && current.targetKey !== null
  && captured.generation === current.generation
  && captured.runtimeKey === current.runtimeKey
  && captured.sessionId === current.sessionId
  && captured.targetKey === current.targetKey
);
