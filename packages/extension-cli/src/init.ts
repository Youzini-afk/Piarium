import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isExtensionId } from "./project.js";

export interface InitOptions {
  directory?: string;
  id: string;
  name: string;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const templateFiles = (options: InitOptions): Record<string, string> => {
  const surfaceEntrypointId = `${options.id}.surface`;
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
          supports: ["desktop", "mobile", "vscode", "web"],
        }],
      },
    }),
    "package.json": json({
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
      },
      devDependencies: {
        "@piarium/extension-cli": "0.1.0",
        typescript: "^5.9.0",
      },
      piarium: {
        build: {
          entrypoints: {
            [surfaceEntrypointId]: { source: "src/surface.ts" },
          },
        },
      },
      engines: { node: ">=22.19.0" },
    }),
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src/**/*.ts"],
    }),
    "src/surface.ts": `import type { PiariumExtensionStaticContribution } from "@piarium/extension-contract";\nimport { defineSurfaceExtension, type PiariumManagedSurfaceContext } from "@piarium/extension-sdk";\n\nconst contribution: PiariumExtensionStaticContribution = {\n  id: ${JSON.stringify(`${options.id}.surface.page`)},\n  kind: "page",\n  contractVersion: 1,\n  data: {},\n  supports: ["desktop", "mobile", "vscode", "web"],\n  title: ${JSON.stringify(options.name)},\n};\n\nexport default defineSurfaceExtension((context: PiariumManagedSurfaceContext) => {\n  context.contribute(contribution, {\n    render: () => undefined,\n  });\n});\n`,
    "README.md": `# ${options.name}\n\nA managed Surface extension for Piarium. The extension and any companion Pi package are separate products; this package only extends the Piarium Surface.\n\n## Commands\n\nInstall the author CLI, then run:\n\n\`\`\`sh\nnpx piarium-extension check\nnpx piarium-extension build\nnpx piarium-extension test\n\`\`\`\n\nThe manifest keeps the published artifact at \`dist/surface.cjs\`. The \`piarium.build\` section maps that manifest target to the TypeScript source in \`src/surface.ts\`. The build bundles the SDK and produces a self-contained browser-targeted managed Surface module.\n\nEdit \`src/surface.ts\` to add contributions, services, assets, and owner-scoped cleanup through the public SDK.\n`,
  };
};

export const initProject = async (options: InitOptions): Promise<string> => {
  if (!isExtensionId(options.id)) {
    throw new Error(`Invalid extension ID "${options.id}". Use a lowercase namespaced identifier such as dev.example.notes.`);
  }
  if (!options.name.trim()) throw new Error("--name must be a non-empty display name");
  const directory = options.directory ?? ".";
  await mkdir(directory, { recursive: true });
  const existing = await readdir(directory);
  if (existing.length > 0) {
    throw new Error(`Refusing to overwrite non-empty target directory: ${directory}`);
  }
  const files = templateFiles(options);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(directory, relativePath);
    if (relativePath.includes("/")) await mkdir(join(directory, relativePath.slice(0, relativePath.lastIndexOf("/"))), { recursive: true });
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  }
  return directory;
};
