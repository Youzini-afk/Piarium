import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const electron = createRequire(import.meta.url)("electron");
const userData = await mkdtemp(join(tmpdir(), "piarium-electron-user-data-"));
const child = spawn(electron, [appRoot, "--smoke"], {
  env: {
    ...process.env,
    PIARIUM_ELECTRON_SMOKE: "1",
    PIARIUM_SMOKE_USER_DATA: userData,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});
const timer = setTimeout(() => child.kill(), 30_000);
const result = await new Promise((resolve) =>
  child.once("exit", (code, signal) => resolve({ code, signal })),
);
clearTimeout(timer);
try {
  if (result.code !== 0 || !output.includes("PIARIUM_DESKTOP_SMOKE_OK")) {
    throw new Error(`Desktop smoke failed (${JSON.stringify(result)}):\n${output}`);
  }
  process.stdout.write(output);
} finally {
  await rm(userData, { force: true, recursive: true });
}
