import { fileURLToPath } from "node:url";

export function resolveBundledPiHostEntry(): string {
  return fileURLToPath(import.meta.resolve("@piarium/pi-host/host"));
}
