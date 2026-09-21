import { createHash } from "node:crypto";
import type { PiAgentKind } from "@varin/protocol";

export function agentProviderEntityId(
  providerId: string,
  kind: PiAgentKind,
  name: string,
): string {
  return createHash("sha256")
    .update(providerId)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(name)
    .digest("base64url");
}
