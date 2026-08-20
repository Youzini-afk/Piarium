import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isExtensionId } from "./project.js";
import { createInitFiles, isInitTemplate, type InitTemplate } from "./templates.js";

export interface InitOptions {
  directory?: string;
  id: string;
  name: string;
  template?: InitTemplate;
}

export const initProject = async (options: InitOptions): Promise<{ directory: string; template: InitTemplate }> => {
  if (!isExtensionId(options.id)) {
    throw new Error(`Invalid extension ID "${options.id}". Use a lowercase namespaced identifier such as dev.example.notes.`);
  }
  if (!options.name.trim()) throw new Error("--name must be a non-empty display name");
  const template = options.template ?? "surface";
  if (!isInitTemplate(template)) {
    throw new Error(`Unknown init template "${String(template)}". Use surface, shell, editor, view, or language.`);
  }
  const directory = options.directory ?? ".";
  await mkdir(directory, { recursive: true });
  const existing = await readdir(directory);
  if (existing.length > 0) {
    throw new Error(`Refusing to overwrite non-empty target directory: ${directory}`);
  }
  const files = createInitFiles({ id: options.id, name: options.name, template });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(directory, relativePath);
    if (relativePath.includes("/")) await mkdir(join(directory, relativePath.slice(0, relativePath.lastIndexOf("/"))), { recursive: true });
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  }
  return { directory, template };
};
