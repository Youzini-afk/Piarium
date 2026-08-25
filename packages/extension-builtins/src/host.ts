import { fileURLToPath } from "node:url";
import { PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID } from "./index.js";

export const PIARIUM_BUILTIN_EXTENSION_PACKAGE_ROOTS: ReadonlyMap<string, string> = new Map([
  [
    PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
    fileURLToPath(new URL("./builtin-packages/typescript-language/", import.meta.url)),
  ],
]);
