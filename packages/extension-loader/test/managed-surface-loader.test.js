import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { SurfaceExtensionRuntime } from "@piarium/extension-surface";
import { ManagedSurfaceExtensionLoader } from "../src/index.js";
if (!globalThis.crypto)
    Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const hostId = "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a";
const realmId = "window-test";
const integrityFor = (value) => `sha256-${createHash("sha256").update(value).digest("hex")}`;
const asset = (value, artifactIntegrity, path, contentType = "text/javascript; charset=utf-8") => ({
    artifactIntegrity,
    bytesBase64: Buffer.from(value).toString("base64"),
    contentType,
    integrity: integrityFor(value),
    path,
});
const manifest = (version) => ({
    schemaVersion: 1,
    id: "dev.example.managed",
    version,
    engines: { piarium: "*" },
    entrypoints: {
        surfaces: [{ id: "main", file: "surface.js", mode: "managed", supports: ["web"] }],
    },
});
const catalogEntry = (version, artifactIntegrity) => ({
    actual: [],
    capabilityGrants: [],
    desired: { enabled: true, revision: 1, updatedAt: "2026-08-14T00:00:00.000Z" },
    installedAt: "2026-08-14T00:00:00.000Z",
    integrity: artifactIntegrity,
    manifest: manifest(version),
    resolvedVersion: version,
    selectedVersion: version,
    source: { display: "Test", kind: "local" },
    updatedAt: "2026-08-14T00:00:00.000Z",
});
const snapshot = (revision, entry) => ({
    authoritative: true,
    diagnostics: [],
    extensions: [entry],
    hostId,
    loadedAt: "2026-08-14T00:00:00.000Z",
    revision,
    schemaVersion: 1,
    storageState: "ready",
});
test("managed candidate activation, rollback, style ownership, and disable are refresh-free", async () => {
    const v1Integrity = integrityFor("artifact-v1");
    const failedIntegrity = integrityFor("artifact-failed");
    const v3Integrity = integrityFor("artifact-v3");
    let current = snapshot(1, catalogEntry("1.0.0", v1Integrity));
    const code = new Map([[v1Integrity, "v1"], [failedIntegrity, "fail"], [v3Integrity, "v3"]]);
    const reported = [];
    let selections = 0;
    let committedStyles = 0;
    const styleHost = {
        stage: () => {
            let committed = false;
            return {
                commit: () => {
                    if (!committed)
                        committedStyles += 1;
                    committed = true;
                },
                dispose: () => {
                    if (committed)
                        committedStyles -= 1;
                    committed = false;
                },
            };
        },
    };
    const runtime = new SurfaceExtensionRuntime({ surface: "web" });
    const loader = new ManagedSurfaceExtensionLoader({
        evaluateModule: (source) => ({
            default: {
                activate: (context) => {
                    if (source === "fail")
                        throw new Error("candidate module failed");
                    context.contribute({
                        contractVersion: 1,
                        data: {},
                        id: "dev.example.managed.page",
                        kind: "page",
                        supports: ["web"],
                    }, { version: source });
                },
            },
        }),
        host: {
            catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
            readAsset: async () => { throw new Error("unexpected asset read"); },
            readManagedEntrypoint: async (request) => {
                const source = code.get(request.integrity);
                if (!source)
                    throw new Error("unknown artifact");
                return {
                    artifactIntegrity: request.integrity,
                    entrypointId: request.entrypointId,
                    module: asset(source, request.integrity, "runtime/surface/main/module.cjs"),
                    styles: [asset(".managed {}", request.integrity, "runtime/surface/main/module.css", "text/css; charset=utf-8")],
                };
            },
            reportActualState: async (_extensionId, state) => { reported.push(state); },
            selectCandidate: async (request) => {
                selections += 1;
                const entry = current.extensions[0];
                assert.equal(entry.candidate?.integrity, request.candidateIntegrity);
                const candidate = entry.candidate;
                if (!candidate)
                    throw new Error("candidate disappeared");
                const { candidate: _candidate, ...selectedEntry } = entry;
                void _candidate;
                current = snapshot(current.revision + 1, {
                    ...selectedEntry,
                    integrity: candidate.integrity,
                    manifest: candidate.manifest,
                    resolvedVersion: candidate.resolvedVersion,
                    selectedVersion: candidate.resolvedVersion,
                    source: candidate.source,
                });
                return current;
            },
        },
        realmId,
        styleHost,
        surface: "web",
        surfaceRuntime: runtime,
    });
    await loader.reconcile();
    assert.equal((runtime.getSnapshot().visibleContributions[0]?.implementation).version, "v1");
    assert.equal(committedStyles, 1);
    current = snapshot(2, {
        ...current.extensions[0],
        candidate: {
            integrity: failedIntegrity,
            manifest: manifest("2.0.0"),
            preparedAt: "2026-08-14T00:01:00.000Z",
            resolvedVersion: "2.0.0",
            source: { display: "Test", kind: "local" },
        },
    });
    await loader.reconcile();
    assert.equal((runtime.getSnapshot().visibleContributions[0]?.implementation).version, "v1");
    assert.equal(selections, 0);
    assert.equal(committedStyles, 1);
    current = snapshot(3, {
        ...current.extensions[0],
        candidate: {
            integrity: v3Integrity,
            manifest: manifest("3.0.0"),
            preparedAt: "2026-08-14T00:02:00.000Z",
            resolvedVersion: "3.0.0",
            source: { display: "Test", kind: "local" },
        },
    });
    await loader.reconcile();
    assert.equal((runtime.getSnapshot().visibleContributions[0]?.implementation).version, "v3");
    assert.equal(selections, 1);
    assert.equal(committedStyles, 1);
    current = snapshot(current.revision + 1, {
        ...current.extensions[0],
        desired: { enabled: false, revision: 2, updatedAt: "2026-08-14T00:03:00.000Z" },
    });
    await loader.reconcile();
    assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
    assert.equal(committedStyles, 0);
    assert.equal(reported.some((state) => state.status === "active"), true);
    assert.equal(reported.some((state) => state.status === "inactive"), true);
});
//# sourceMappingURL=managed-surface-loader.test.js.map