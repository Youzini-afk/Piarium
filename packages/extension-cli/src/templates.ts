export const INIT_TEMPLATES = ["surface", "shell", "editor", "view", "language"] as const;
export type InitTemplate = (typeof INIT_TEMPLATES)[number];

export const isInitTemplate = (value: string): value is InitTemplate => (
  (INIT_TEMPLATES as readonly string[]).includes(value)
);

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const packageJson = (options: {
  extraDependencies?: Record<string, string>;
  extraEntrypoints?: Record<string, { source: string }>;
  id: string;
  name: string;
}): string => json({
  name: options.id,
  version: "0.1.0",
  private: false,
  type: "module",
  description: `${options.name} Piarium extension`,
  files: ["dist", "piarium.extension.json"],
  scripts: {
    build: "piarium-extension build",
    check: "piarium-extension check",
    test: "piarium-extension test",
  },
  dependencies: {
    "@piarium/extension-contract": "0.1.0",
    "@piarium/extension-sdk": "0.1.0",
    ...options.extraDependencies,
  },
  devDependencies: {
    "@piarium/extension-cli": "0.1.0",
    typescript: "^5.9.0",
  },
  piarium: {
    build: {
      entrypoints: options.extraEntrypoints,
    },
  },
  engines: { node: ">=22.19.0" },
});

const tsconfig = (): string => json({
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["src/**/*.ts"],
});

const readme = (options: { name: string; summary: string }): string => `# ${options.name}

${options.summary}

This package extends the Piarium Surface or Host. It is not a Pi package.

## Commands

\`\`\`sh
npx piarium-extension check
npx piarium-extension build
npx piarium-extension test
\`\`\`

Import \`@piarium/extension-sdk\` and \`@piarium/extension-contract\` only. Do not import Piarium's React product UI.
`;

export const createInitFiles = (options: {
  id: string;
  name: string;
  template: InitTemplate;
}): Record<string, string> => {
  const surfaceEntrypointId = `${options.id}.surface`;
  const hostEntrypointId = "host";
  if (options.template === "language") {
    return {
      "piarium.extension.json": json({
        $schema: "https://raw.githubusercontent.com/Youzini-afk/Piarium/main/packages/extension-contract/schema/piarium.extension.schema.json",
        schemaVersion: 1,
        id: options.id,
        version: "0.1.0",
        displayName: options.name,
        metadata: { description: `${options.name} language provider` },
        engines: { piarium: "*" },
        capabilities: { host: ["workspace.language"] },
        entrypoints: {
          host: { file: "dist/host.cjs", mode: "brokered", activation: ["workspace-match"] },
        },
      }),
      "package.json": packageJson({
        id: options.id,
        name: options.name,
        extraEntrypoints: { [hostEntrypointId]: { source: "src/host.ts" } },
      }),
      "tsconfig.json": tsconfig(),
      "src/host.ts": `import { defineLanguageProvider } from "@piarium/extension-sdk";\n\nexport default defineLanguageProvider({\n  providerId: ${JSON.stringify(`${options.id}.markdown`)},\n  command: "node",\n  args: ["./language-server.mjs"],\n  languageIds: ["markdown"],\n});\n`,
      "README.md": readme({
        name: options.name,
        summary: "A brokered Host language provider. The Application Host spawns the server; this extension never starts a debugger or language process in the renderer.",
      }),
    };
  }

  const contribution = options.template === "shell"
    ? {
      id: `${options.id}.shell`,
      kind: "shell",
      replacement: { target: "workbench.shell" },
      title: options.name,
    }
    : options.template === "editor"
      ? {
        id: `${options.id}.editor`,
        kind: "editor",
        placement: { slot: "workbench.editor.actions" },
        title: options.name,
      }
      : options.template === "view"
        ? {
          id: `${options.id}.view`,
          kind: "view",
          placement: { slot: "workbench.primary-sidebar.views", order: 40 },
          title: options.name,
        }
        : {
          id: `${options.id}.surface.page`,
          kind: "page",
          title: options.name,
        };

  const source = options.template === "shell"
    ? `import { defineShellMount, defineSurfaceExtension, type PiariumManagedSurfaceContext } from "@piarium/extension-sdk";\nimport { PIARIUM_WORKBENCH_REPLACEMENT_TARGETS } from "@piarium/extension-contract";\n\nexport default defineSurfaceExtension((context: PiariumManagedSurfaceContext) => {\n  context.contribute({\n    id: ${JSON.stringify(contribution.id)},\n    kind: "shell",\n    contractVersion: 1,\n    data: {},\n    supports: ["desktop", "web"],\n    title: ${JSON.stringify(options.name)},\n    replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell },\n  }, defineShellMount((container) => {\n    container.replaceChildren();\n    const root = container.ownerDocument.createElement("main");\n    root.textContent = ${JSON.stringify(options.name)};\n    container.append(root);\n    return () => { container.replaceChildren(); };\n  }));\n});\n`
    : options.template === "editor"
      ? `import { defineEditorMount, defineSurfaceExtension, type PiariumManagedSurfaceContext } from "@piarium/extension-sdk";\nimport { PIARIUM_WORKBENCH_SLOTS } from "@piarium/extension-contract";\n\nexport default defineSurfaceExtension((context: PiariumManagedSurfaceContext) => {\n  context.contribute({\n    id: ${JSON.stringify(contribution.id)},\n    kind: "editor",\n    contractVersion: 1,\n    data: { languageIds: ["markdown"] },\n    supports: ["desktop", "web"],\n    title: ${JSON.stringify(options.name)},\n    placement: { slot: PIARIUM_WORKBENCH_SLOTS.editorActions },\n  }, defineEditorMount((container, mount) => {\n    container.textContent = mount.contributionId;\n    return () => { container.replaceChildren(); };\n  }));\n});\n`
      : options.template === "view"
        ? `import { defineViewMount, defineSurfaceExtension, type PiariumManagedSurfaceContext } from "@piarium/extension-sdk";\nimport { PIARIUM_WORKBENCH_SLOTS } from "@piarium/extension-contract";\n\nexport default defineSurfaceExtension((context: PiariumManagedSurfaceContext) => {\n  context.contribute({\n    id: ${JSON.stringify(contribution.id)},\n    kind: "view",\n    contractVersion: 1,\n    data: {},\n    supports: ["desktop", "web"],\n    title: ${JSON.stringify(options.name)},\n    placement: { slot: PIARIUM_WORKBENCH_SLOTS.primarySidebarViews, order: 40 },\n  }, defineViewMount((container) => {\n    container.textContent = ${JSON.stringify(options.name)};\n    return () => { container.replaceChildren(); };\n  }));\n});\n`
        : `import type { PiariumExtensionStaticContribution } from "@piarium/extension-contract";\nimport { defineSurfaceExtension, type PiariumManagedSurfaceContext } from "@piarium/extension-sdk";\n\nconst contribution: PiariumExtensionStaticContribution = {\n  id: ${JSON.stringify(contribution.id)},\n  kind: "page",\n  contractVersion: 1,\n  data: {},\n  supports: ["desktop", "mobile", "vscode", "web"],\n  title: ${JSON.stringify(options.name)},\n};\n\nexport default defineSurfaceExtension((context: PiariumManagedSurfaceContext) => {\n  context.contribute(contribution, {\n    render: () => undefined,\n  });\n});\n`;

  return {
    "piarium.extension.json": json({
      $schema: "https://raw.githubusercontent.com/Youzini-afk/Piarium/main/packages/extension-contract/schema/piarium.extension.schema.json",
      schemaVersion: 1,
      id: options.id,
      version: "0.1.0",
      displayName: options.name,
      metadata: { description: `${options.name} Piarium extension` },
      engines: { piarium: "*" },
      entrypoints: {
        surfaces: [{
          id: surfaceEntrypointId,
          file: "dist/surface.cjs",
          mode: "managed",
          supports: options.template === "surface" ? ["desktop", "mobile", "vscode", "web"] : ["desktop", "web"],
        }],
      },
    }),
    "package.json": packageJson({
      id: options.id,
      name: options.name,
      extraEntrypoints: { [surfaceEntrypointId]: { source: "src/surface.ts" } },
    }),
    "tsconfig.json": tsconfig(),
    "src/surface.ts": source,
    "README.md": readme({
      name: options.name,
      summary: options.template === "shell"
        ? "A framework-neutral Shell replacement. Core still owns documents, terminals, and sessions; this package only draws the workbench chrome."
        : options.template === "editor"
          ? "A custom resource editor contribution. Document buffers stay in Piarium DocumentsAPI."
          : options.template === "view"
            ? "A sidebar view contribution placed through a public workbench slot."
            : "A managed Surface extension for Piarium.",
    }),
  };
};
