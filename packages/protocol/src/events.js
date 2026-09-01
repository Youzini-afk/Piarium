export const HOST_EVENTS = [
    "agent.event",
    "config.changed",
    "extension.ui.dismiss",
    "extension.ui.request",
    "extension.state",
    "host.error",
    "host.log",
    "host.ready",
    "package.progress",
    "project.trust.request",
    "provider.auth.dismiss",
    "provider.auth.event",
    "provider.auth.prompt",
    "provider.config.changed",
    "recovery.changed",
    "recovery.status",
    "session.closed",
    "session.snapshot",
    "session.worker.exited",
    "workspace.mutation.request",
];
const HOST_EVENT_SET = new Set(HOST_EVENTS);
export function isHostEvent(value) {
    return typeof value === "string" && HOST_EVENT_SET.has(value);
}
//# sourceMappingURL=events.js.map