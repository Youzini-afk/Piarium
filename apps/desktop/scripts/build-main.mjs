import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputRoot = join(appRoot, "dist", "main");
await rm(outputRoot, { force: true, recursive: true });

await build({
  bundle: true,
  entryNames: "[name]",
  entryPoints: {
    main: join(appRoot, "src", "main", "main.ts"),
    "runtime-broker": join(appRoot, "src", "main", "runtime-broker.ts"),
  },
  external: ["electron", "@piarium/pi-host", "@piarium/pi-host/*", "@piarium/protocol"],
  format: "esm",
  logLevel: "info",
  outdir: outputRoot,
  platform: "node",
  sourcemap: true,
  target: "node24",
});

await build({
  bundle: true,
  entryPoints: [join(appRoot, "src", "preload", "preload.ts")],
  external: ["electron"],
  format: "cjs",
  logLevel: "info",
  outfile: join(outputRoot, "preload.cjs"),
  platform: "node",
  sourcemap: true,
  target: "node24",
});
