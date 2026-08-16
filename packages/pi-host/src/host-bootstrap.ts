#!/usr/bin/env node

import { register } from "node:module";

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const argv = process.argv.slice(2);
const packageRoot = readFlag(argv, "--package-root") ?? process.env.PIARIUM_PI_PACKAGE_ROOT;
if (packageRoot) {
  register(new URL("./pi-sdk-resolver.js", import.meta.url), {
    data: { packageRoot },
    parentURL: import.meta.url,
  });
}

await import("./main.js");
