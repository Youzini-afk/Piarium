import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  JsonValue,
  PiFleetEntry,
  PiFleetLogsData,
  PiFleetProviderSnapshot,
} from "@piarium/protocol";

export type ExtensionEventBus = ExtensionAPI["events"];

export interface PiFleetProviderResult {
  entries: PiFleetEntry[];
  omitted: number;
  provider: PiFleetProviderSnapshot;
  totalActive: number;
}

export interface PiFleetProviderActionRequest {
  action: string;
  entryKey?: string;
  input?: JsonValue;
  sessionId: string;
}

export interface PiFleetProviderActionResult {
  entry?: PiFleetEntry;
  logs?: PiFleetLogsData;
  message: string;
  success: boolean;
}

export interface FleetProviderAdapter {
  readonly id: string;
  action?(request: PiFleetProviderActionRequest): Promise<PiFleetProviderActionResult>;
  attach(events: ExtensionEventBus): () => void;
  endSession(): void;
  startSession(sessionId: string): void;
  status(sessionId: string): Promise<PiFleetProviderResult>;
}
