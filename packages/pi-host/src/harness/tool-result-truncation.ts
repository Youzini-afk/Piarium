import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";

const DEFAULT_VISIBLE_BYTES = 32768;
const DEFAULT_HEAD_RATIO = 0.5;
const BASH_HEAD_RATIO = 0.375;
const MAX_NEWLINE_BACKTRACK = 512;

function findNearestNewlineBefore(text: string, position: number): number {
  for (let i = position; i > Math.max(0, position - MAX_NEWLINE_BACKTRACK); i--) {
    if (text[i] === "\n") return i;
  }
  return position;
}

export interface ToolResultTruncationOptions {
  bridge: HostServicesBridge;
  visibleBytes?: number;
  sessionId: string;
}

export function createToolResultTruncationExtension(options: ToolResultTruncationOptions): ExtensionFactory {
  const visibleBytes = options.visibleBytes ?? DEFAULT_VISIBLE_BYTES;
  const bridge = options.bridge;
  const _sessionId = options.sessionId;

  return (pi) => {
    pi.on("tool_result", async (event) => {
      const content = event.content;
      if (!content) return undefined;

      const toolName = event.toolName;
      const headRatio = toolName === "bash" ? BASH_HEAD_RATIO : DEFAULT_HEAD_RATIO;

      // Concatenate all TextContent
      const textParts: string[] = [];
      for (const part of content) {
        if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
      const fullText = textParts.join("");
      const byteLength = Buffer.byteLength(fullText, "utf8");

      if (byteLength <= visibleBytes) return undefined;

      // Split into head and tail
      const headBytes = Math.floor(visibleBytes * headRatio);
      const tailBytes = visibleBytes - headBytes;

      // Convert byte offsets to character offsets (approximate — works for BMP text)
      const headCharOffset = Math.min(fullText.length, headBytes);
      const tailCharStart = Math.max(0, fullText.length - tailBytes);

      // Backtrack to nearest newline
      const headCut = findNearestNewlineBefore(fullText, headCharOffset);
      const tailCut = fullText.indexOf("\n", tailCharStart);
      const tailStart = tailCut === -1 ? tailCharStart : tailCut + 1;

      const head = fullText.slice(0, headCut);
      const tail = fullText.slice(tailStart);

      // Store full text via output.store
      let handle: string;
      let total: number;
      try {
        const stored = await bridge.request("output.store", { text: fullText, label: toolName });
        handle = stored.handle;
        total = stored.total;
      } catch {
        // If output.store fails, leave the result untruncated
        return undefined;
      }

      const truncatedText = `${head}\n…\n${tail}\n[output: ${total} bytes; showing first ${head.length} and last ${tail.length} — get_output("${handle}", offset, length) for more]`;

      // Replace text content
      const newContent = [{ type: "text" as const, text: truncatedText }];
      const newDetails = {
        ...(event.details ?? {}),
        truncated: { handle, total, head: head.length, tail: tail.length },
      };

      return {
        content: newContent,
        details: newDetails,
      };
    });
  };
}
