import { createErrorResponse, } from "./envelopes.js";
import { PIARIUM_PROTOCOL_VERSION, } from "./types.js";
export const RUNTIME_METHODS = [
    "agent.abort",
    "agent.followUp",
    "agent.prompt",
    "agent.queue.clear",
    "agent.steer",
    "agentProvider.action",
    "agentProvider.list",
    "command.execute",
    "command.list",
    "config.document.get",
    "config.document.update",
    "config.text.authority.get",
    "config.text.authority.update",
    "config.text.get",
    "config.text.update",
    "config.unwatch",
    "config.watch",
    "extension.ui.respond",
    "fleet.action",
    "fleet.status",
    "host.handshake",
    "model.list",
    "mcp.config.snapshot",
    "model.select",
    "thinking.select",
    "package.install",
    "package.foundation.restore",
    "package.foundation.setAutoInstallNew",
    "package.foundation.status",
    "package.list",
    "package.remove",
    "package.setEnabled",
    "package.update",
    "project.trust.respond",
    "provider.list",
    "provider.config.delete",
    "provider.config.get",
    "provider.config.upsert",
    "provider.models.discover",
    "provider.auth.respond",
    "provider.login",
    "provider.logout",
    "resource.copy",
    "resource.create",
    "resource.delete",
    "resource.get",
    "resource.list",
    "resource.update",
    "recovery.checkpoint.create",
    "recovery.navigate",
    "recovery.repair",
    "recovery.redo",
    "recovery.status",
    "recovery.undo",
    "session.close",
    "session.create",
    "session.delete",
    "session.entry",
    "session.entries",
    "session.entries.preview",
    "session.features.get",
    "session.features.mutate",
    "session.fork",
    "session.header",
    "session.list",
    "session.navigate",
    "session.open",
    "session.rename",
    "session.snapshot",
    "session.stats",
    "session.summary",
    "session.tree",
    "session.archive",
    "session.unarchive",
    "settings.get",
    "settings.update",
];
const RUNTIME_METHOD_SET = new Set(RUNTIME_METHODS);
export function isRuntimeMethod(value) {
    return typeof value === "string" && RUNTIME_METHOD_SET.has(value);
}
export const RUNTIME_WORKER_ROLES = ["catalog", "workspace", "package", "session"];
export function createRuntimeRequest(id, method, params) {
    return {
        id,
        kind: "request",
        method,
        params,
        v: PIARIUM_PROTOCOL_VERSION,
    };
}
export function createRuntimeSuccessResponse(id, result) {
    return {
        id,
        kind: "response",
        ok: true,
        result,
        v: PIARIUM_PROTOCOL_VERSION,
    };
}
export function createRuntimeErrorResponse(id, error) {
    return createErrorResponse(id, error);
}
export function createRuntimeEvent(source, seq, event, data) {
    return {
        data,
        event,
        kind: "event",
        seq,
        source,
        v: PIARIUM_PROTOCOL_VERSION,
    };
}
export function isRuntimeEventEnvelope(envelope) {
    if (envelope.kind !== "event")
        return false;
    const source = envelope.source;
    if (typeof source !== "object" || source === null || Array.isArray(source))
        return false;
    const record = source;
    return (RUNTIME_WORKER_ROLES.includes(record.role) &&
        typeof record.workerId === "string" &&
        record.workerId.length > 0 &&
        (record.sessionId === undefined ||
            (typeof record.sessionId === "string" && record.sessionId.length > 0)));
}
//# sourceMappingURL=runtime.js.map