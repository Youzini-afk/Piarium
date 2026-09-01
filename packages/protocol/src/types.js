// Piarium is pre-release and all product surfaces ship in lockstep. Breaking
// development changes replace this single contract instead of accumulating
// compatibility versions that no released client needs.
export const PIARIUM_PROTOCOL_VERSION = 1;
export const PI_RUNTIME_ISSUE_HOST_ENTRY_UNAVAILABLE = "host-entry-unavailable";
export const PI_RUNTIME_ISSUE_CODES = [
    PI_RUNTIME_ISSUE_HOST_ENTRY_UNAVAILABLE,
];
export const RUNTIME_SOURCE_KINDS = [
    "bundled",
    "system",
    "standalone",
    "custom",
    "development",
    "source",
];
export const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
//# sourceMappingURL=types.js.map