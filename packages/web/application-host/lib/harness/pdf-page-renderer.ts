import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebDocumentRegion } from "@varin/protocol";

export interface PdfPageRenderer {
  (source: Buffer, page: number, region?: WebDocumentRegion, signal?: AbortSignal): Promise<{
    data: Buffer;
    mimeType: "image/png";
  }>;
}

interface ProcessResult {
  code: number | null;
  stderr: string;
}

const run = (command: string, args: string[], signal?: AbortSignal): Promise<ProcessResult> => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const onAbort = (): void => {
    child.kill();
    reject(signal?.reason ?? new DOMException("PDF render aborted", "AbortError"));
  };
  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  child.once("error", (error) => {
    signal?.removeEventListener("abort", onAbort);
    reject(error);
  });
  child.once("exit", (code) => {
    signal?.removeEventListener("abort", onAbort);
    resolve({ code, stderr });
  });
});

/**
 * Render one page through Poppler when it is available on the Host. The
 * executable can be supplied explicitly for packaged installations; keeping
 * this adapter optional means text extraction and ordinary web fetching do not
 * depend on a native graphics stack.
 */
export const createPopplerPdfPageRenderer = (command = process.env.VARIN_PDFTOPPM_PATH ?? "pdftoppm"): PdfPageRenderer => (
  async (source, page, region, signal) => {
    const root = await mkdtemp(join(tmpdir(), "varin-pdf-page-"));
    const input = join(root, "source.pdf");
    const outputPrefix = join(root, "page");
    const output = `${outputPrefix}.png`;
    try {
      await writeFile(input, source);
      const regionArgs = region ? [
        "-x", String(Math.round(region.x)),
        "-y", String(Math.round(region.y)),
        "-W", String(Math.round(region.width)),
        "-H", String(Math.round(region.height)),
      ] : [];
      const result = await run(command, [
        "-f", String(page),
        "-l", String(page),
        "-singlefile",
        "-png",
        "-r", "144",
        ...regionArgs,
        input,
        outputPrefix,
      ], signal);
      if (result.code !== 0) {
        const detail = result.stderr.trim();
        throw new Error(detail ? `pdftoppm exited with ${result.code}: ${detail}` : `pdftoppm exited with ${result.code}`);
      }
      return { data: await readFile(output), mimeType: "image/png" };
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
);
