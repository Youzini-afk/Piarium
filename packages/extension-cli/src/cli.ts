#!/usr/bin/env node
import { buildProject } from "./build.js";
import { initProject } from "./init.js";
import { checkProject, formatContractError } from "./project.js";
import { testProject } from "./test-command.js";
import { pathToFileURL } from "node:url";

const usage = `Usage:
  piarium-extension init [dir] --id <extension-id> --name <display-name>
  piarium-extension check [dir]
  piarium-extension build [dir]
  piarium-extension test [dir]
`;

interface ParsedArgs {
  command: string | undefined;
  directory: string | undefined;
  id: string | undefined;
  name: string | undefined;
}

const parseArgs = (args: string[]): ParsedArgs => {
  const result: ParsedArgs = { command: undefined, directory: undefined, id: undefined, name: undefined };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value === "--help" || value === "-h") return { command: "help", directory: undefined, id: undefined, name: undefined };
    if (value === "--id" || value === "--name") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      if (value === "--id") result.id = next;
      else result.name = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--id=") || value.startsWith("--name=")) {
      const split = value.indexOf("=");
      const option = value.slice(0, split);
      const optionValue = value.slice(split + 1);
      if (!optionValue) throw new Error(`${option} requires a value`);
      if (option === "--id") result.id = optionValue;
      else result.name = optionValue;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    positional.push(value);
  }
  result.command = positional.shift();
  if (positional.length > 1) throw new Error(`Unexpected arguments: ${positional.slice(1).join(" ")}`);
  result.directory = positional[0];
  return result;
};

export const runCli = async (args: string[], output = console): Promise<number> => {
  try {
    const parsed = parseArgs(args);
    if (!parsed.command || parsed.command === "help") {
      output.log(usage);
      return 0;
    }
    if (parsed.command === "init") {
      if (!parsed.id || !parsed.name) throw new Error("init requires both --id and --name; the command is non-interactive");
      const directory = await initProject({
        ...(parsed.directory ? { directory: parsed.directory } : {}),
        id: parsed.id,
        name: parsed.name,
      });
      output.log(`Created Piarium extension template in ${directory}`);
      return 0;
    }
    if (parsed.command === "check") {
      const result = await checkProject(parsed.directory);
      if (result.missingFiles.length > 0) {
        throw new Error(`Manifest is valid, but referenced entrypoint files are missing: ${result.missingFiles.join(", ")}. Run piarium-extension build to create them.`);
      }
      output.log(`OK: ${result.project.manifest.id}@${result.project.manifest.version} (${result.referencedFiles.length} referenced entrypoint file${result.referencedFiles.length === 1 ? "" : "s"})`);
      return 0;
    }
    if (parsed.command === "build") {
      const result = await buildProject(parsed.directory);
      if (result.outputs.length === 0) output.log(`OK: ${result.project.manifest.id} has no executable entrypoints (declarative-only)`);
      else {
        output.log(`Built ${result.project.manifest.id}@${result.project.manifest.version}:`);
        for (const item of result.outputs) output.log(`  ${item.kind} ${item.entrypointId} (${item.mode}) -> ${item.file}`);
      }
      return 0;
    }
    if (parsed.command === "test") {
      const result = await testProject(parsed.directory);
      output.log(`PASS: ${result.project.manifest.id}@${result.project.manifest.version}`);
      for (const surface of result.surfaces) output.log(`  Surface ${surface.entrypointId}: ${surface.result} (${surface.mode})`);
      output.log(`  Host: ${result.host}`);
      return 0;
    }
    throw new Error(`Unknown command: ${parsed.command}\n\n${usage}`);
  } catch (error) {
    for (const message of formatContractError(error)) output.error(`Error: ${message}`);
    return 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
