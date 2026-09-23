import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebDocumentRegion } from "@varin/protocol";
import type { PdfPageRenderer } from "./pdf-page-renderer.js";

const runTesseract = (command: string, args: string[], signal?: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const abort = (): void => {
    child.kill();
    reject(signal?.reason ?? new DOMException("OCR aborted", "AbortError"));
  };
  if (signal?.aborted) {
    abort();
    return;
  }
  signal?.addEventListener("abort", abort, { once: true });
  child.once("error", (error) => {
    signal?.removeEventListener("abort", abort);
    reject(error);
  });
  child.once("exit", (code) => {
    signal?.removeEventListener("abort", abort);
    if (code === 0) resolve(stdout);
    else reject(new Error(stderr.trim() || `tesseract exited with ${code}`));
  });
});

/** Optional system OCR adapter. It is loaded only when OCR is explicitly requested. */
export const createTesseractPdfOcr = (
  renderPage: PdfPageRenderer,
  command = process.env.VARIN_TESSERACT_PATH ?? "tesseract",
  language = process.env.VARIN_TESSERACT_LANG ?? "eng",
) => async (input: { source: Buffer; page: number; signal?: AbortSignal }): Promise<{ text: string; engine: string }> => {
  const rendered = await renderPage(input.source, input.page, undefined as WebDocumentRegion | undefined, input.signal);
  const root = await mkdtemp(join(tmpdir(), "varin-pdf-ocr-"));
  const imagePath = join(root, "page.png");
  try {
    await writeFile(imagePath, rendered.data);
    const text = await runTesseract(command, [imagePath, "stdout", "-l", language, "--psm", "3"], input.signal);
    return { text: text.trim(), engine: `tesseract:${language}` };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
};
