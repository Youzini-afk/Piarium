import type { PiariumApplicationSurface } from "../src/types.js";

export interface ManifestFixture {
  readonly label: string;
  readonly manifest: unknown;
  readonly schemaValid: boolean;
  readonly runtimeValid: boolean;
  readonly compatible: boolean;
}

const surface = (s: PiariumApplicationSurface): PiariumApplicationSurface => s;

const baseManifest = () => ({
  schemaVersion: 1,
  id: "dev.example.fixtures",
  version: "1.0.0",
  engines: { piarium: ">=0.2.0" },
});

const baseContribution = () => ({
  id: "dev.example.fixtures.view",
  kind: "view" as const,
  contractVersion: 1,
  data: {},
  supports: ["web" as const],
});

const baseSurfaceEntrypoint = () => ({
  id: "main",
  mode: "managed" as const,
  file: "dist/main.js",
  supports: ["web" as const],
});

export const manifestFixtures: readonly ManifestFixture[] = [
  {
    label: "valid declarative entrypoint without file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "declarative",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: true,
    runtimeValid: true,
    compatible: true,
  },
  {
    label: "valid managed entrypoint with file",
    manifest: {
      ...baseManifest(),
      entrypoints: { surfaces: [baseSurfaceEntrypoint()] },
      contributions: [baseContribution()],
    },
    schemaValid: true,
    runtimeValid: true,
    compatible: true,
  },
  {
    label: "valid isolated entrypoint with file and isolation",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "isolated",
          file: "dist/main.js",
          isolation: "iframe",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: true,
    runtimeValid: true,
    compatible: true,
  },
  {
    label: "valid native entrypoint with file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "native",
          file: "dist/main.js",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: true,
    runtimeValid: true,
    compatible: true,
  },
  {
    label: "valid brokered host entrypoint with file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        host: { file: "dist/host.js", mode: "brokered" },
      },
      contributions: [baseContribution()],
    },
    schemaValid: true,
    runtimeValid: true,
    compatible: true,
  },
  {
    label: "managed entrypoint missing file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "managed",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: false,
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "isolated entrypoint missing file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "isolated",
          isolation: "iframe",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: false,
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "native entrypoint missing file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "native",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: false,
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "host entrypoint missing file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        host: { mode: "brokered" },
      },
      contributions: [baseContribution()],
    },
    schemaValid: false,
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "invalid SemVer version",
    manifest: {
      ...baseManifest(),
      version: "not-a-version",
      contributions: [baseContribution()],
    },
    schemaValid: false,
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "invalid engine range",
    manifest: {
      ...baseManifest(),
      engines: { piarium: "not-a-range" },
      contributions: [baseContribution()],
    },
    schemaValid: false, // semver-range format now uses real semver.validRange
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "contribution ID not qualified by extension ID",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        id: "unqualified.view",
      }],
    },
    schemaValid: true, // schema cannot express cross-field prefix rules
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "contribution references unknown entrypoint",
    manifest: {
      ...baseManifest(),
      entrypoints: { surfaces: [baseSurfaceEntrypoint()] },
      contributions: [{
        ...baseContribution(),
        entrypoint: "nonexistent",
      }],
    },
    schemaValid: true, // schema cannot express cross-field reference rules
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "contribution supports surface not in entrypoint supports",
    manifest: {
      ...baseManifest(),
      entrypoints: { surfaces: [{ ...baseSurfaceEntrypoint(), supports: ["web"] }] },
      contributions: [{
        ...baseContribution(),
        entrypoint: "main",
        supports: ["desktop"],
      }],
    },
    schemaValid: true, // schema cannot express cross-field support rules
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "contribution requires undeclared capability",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        requiresCapabilities: ["workspace.documents"],
      }],
    },
    schemaValid: true, // schema cannot express cross-field capability rules
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "unknown contract version (parsed but not compatible)",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        contractVersion: 99,
      }],
    },
    schemaValid: true,
    runtimeValid: true,
    compatible: false,
  },
  {
    label: "shell with valid seam data",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.shell",
        kind: "shell",
        contractVersion: 1,
        data: {
          contract: "piarium-workbench-shell/v1",
          seams: {
            web: { replacementTargets: ["workbench.editor"], slots: [] },
          },
        },
        supports: ["web"],
        replacement: { target: "workbench.shell" },
      }],
    },
    schemaValid: true,
    runtimeValid: true,
    compatible: true,
  },
  {
    label: "shell with invalid seam data (missing required surface)",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.shell",
        kind: "shell",
        contractVersion: 1,
        data: {
          contract: "piarium-workbench-shell/v1",
          seams: {},
        },
        supports: ["web"],
        replacement: { target: "workbench.shell" },
      }],
    },
    schemaValid: false,
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "versioned shell data with extra field",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.shell",
        kind: "shell",
        contractVersion: 1,
        data: {
          contract: "piarium-workbench-shell/v1",
          seams: {
            web: { replacementTargets: [], slots: [], extraField: true },
          },
          extraTopLevel: true,
        },
        supports: ["web"],
        replacement: { target: "workbench.shell" },
      }],
    },
    schemaValid: false, // schema enforces additionalProperties: false on shell data
    runtimeValid: true, // runtime does not reject unknown fields in shell data
    compatible: true,
  },
  {
    label: "transition-scene contribution with valid data",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.transition",
        kind: "transition-scene",
        contractVersion: 1,
        data: {
          contract: "piarium-transition-scene/v1",
          scenes: ["workbench-profile"],
          durations: {
            "workbench-profile": {
              covering: { quick: 100, reduced: 200, standard: 300 },
              revealing: { quick: 100, reduced: 200, standard: 300 },
            },
          },
        },
        supports: ["web"],
        replacement: { target: "workbench.transition" },
      }],
    },
    schemaValid: true,
    runtimeValid: true,
    compatible: true,
  },
  {
    label: "editor contribution with valid languageIds",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.editor",
        kind: "editor",
        contractVersion: 1,
        data: { languageIds: ["markdown"] },
        supports: ["web"],
      }],
    },
    schemaValid: true,
    runtimeValid: true,
    compatible: true,
  },
  {
    label: "editor contribution missing both languageIds and filenames",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.editor",
        kind: "editor",
        contractVersion: 1,
        data: {},
        supports: ["web"],
      }],
    },
    schemaValid: false,
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "view contribution with valid structured when expression",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        when: { op: "defined", key: "editorIsOpen" },
      }],
    },
    schemaValid: true,
    runtimeValid: true,
    compatible: true,
  },
  {
    label: "view contribution with nested when expression (all/any)",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        when: {
          op: "all",
          expressions: [
            { op: "defined", key: "editorIsOpen" },
            { op: "any", expressions: [
              { op: "equals", key: "language", value: "markdown" },
              { op: "equals", key: "language", value: "typescript" },
            ]},
          ],
        },
      }],
    },
    schemaValid: true,
    runtimeValid: true,
    compatible: true,
  },
  {
    label: "view contribution with invalid when operator",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        when: { op: "invalid-op", key: "editorIsOpen" },
      }],
    },
    schemaValid: false,
    runtimeValid: false,
    compatible: true,
  },
  {
    label: "shell contribution with when (disallowed)",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.shell",
        kind: "shell",
        contractVersion: 1,
        data: {
          contract: "piarium-workbench-shell/v1",
          seams: {
            web: { replacementTargets: ["workbench.editor"], slots: [] },
          },
        },
        supports: ["web"],
        replacement: { target: "workbench.shell" },
        when: { op: "defined", key: "editorIsOpen" },
      }],
    },
    schemaValid: true,
    runtimeValid: false, // runtime rejects when on shell contributions
    compatible: true,
  },
  {
    label: "transition-scene contribution with when (disallowed)",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.transition",
        kind: "transition-scene",
        contractVersion: 1,
        data: {
          contract: "piarium-transition-scene/v1",
          scenes: ["workbench-profile"],
          durations: {
            "workbench-profile": {
              covering: { quick: 100, reduced: 200, standard: 300 },
              revealing: { quick: 100, reduced: 200, standard: 300 },
            },
          },
        },
        supports: ["web"],
        replacement: { target: "workbench.transition" },
        when: { op: "defined", key: "editorIsOpen" },
      }],
    },
    schemaValid: true,
    runtimeValid: false, // runtime rejects when on transition-scene contributions
    compatible: true,
  },
];
