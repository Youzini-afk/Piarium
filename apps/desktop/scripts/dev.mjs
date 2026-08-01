import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const electron = require("electron");
const server = await createServer({ configFile: `${appRoot}/vite.config.ts` });
await server.listen();
const address = server.resolvedUrls?.local[0] ?? "http://127.0.0.1:4317/";
const child = spawn(electron, [appRoot], {
  env: { ...process.env, PIARIUM_DEV_SERVER_URL: address },
  stdio: "inherit",
  windowsHide: false,
});

const shutdown = async () => {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await server.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
child.once("exit", async (code) => {
  await server.close();
  process.exitCode = code ?? 1;
});
