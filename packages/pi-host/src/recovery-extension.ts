import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { RecoveryCoordinator } from "@piarium/recovery";

export function createRecoveryExtension(coordinator: RecoveryCoordinator): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", async (event, context) => {
      await coordinator.beginTurn(
        context.sessionManager.getSessionId(),
        context.sessionManager.getLeafId(),
        (event.images?.length ?? 0) > 0,
      );
    });
    pi.on("agent_settled", async (_event, context) => {
      const turn = await coordinator.finishTurn({
        entries: context.sessionManager.getBranch(),
        leafId: context.sessionManager.getLeafId(),
        sessionId: context.sessionManager.getSessionId(),
      });
      if (turn) pi.appendEntry("piarium.recovery.turn/v1", turn);
    });
  };
}
