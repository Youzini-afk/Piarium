import { buildSessionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const THREAD_NOTIFICATION_TYPE = "piarium.thread.notification";

const notificationId = (message: AgentMessage): string | undefined => {
  if (message.role !== "custom" || message.customType !== THREAD_NOTIFICATION_TYPE) return undefined;
  const details = message.details as { messageId?: unknown } | undefined;
  return typeof details?.messageId === "string" ? details.messageId : undefined;
};

/**
 * Pi's passive custom-message API appends native history without waking a
 * model. A running tool loop may still hold an older message-array snapshot.
 * At Pi's next context hook, include only missing, still-retained notifications;
 * never replay old summarized notes or create another turn/queue/Agent loop.
 */
export const createThreadInputExtension = (): ExtensionFactory => (pi) => {
  pi.on("context", (event, ctx) => {
    const seen = new Set(event.messages.map(notificationId).filter((id) => id !== undefined));
    const retained = buildSessionContext(ctx.sessionManager.getBranch()).messages;
    const missing = retained.filter((message) => {
      const id = notificationId(message);
      if (id === undefined || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return missing.length ? { messages: [...event.messages, ...missing] } : undefined;
  });
};
