import {
  createReadToolDefinition,
  type ReadOperations,
  type ReadToolOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";

/**
 * Keep Pi's read implementation and rendering intact while selecting the
 * bytes for a dirty editor document through the authenticated Host service.
 */
export function createSurfaceAwareReadTool(
  bridge: HostServicesBridge,
  cwd: string,
  options: Pick<ReadToolOptions, "autoResizeImages"> = {},
): ToolDefinition {
  const native = createReadToolDefinition(cwd, options);
  const wrapped: ReturnType<typeof createReadToolDefinition> = {
    ...native,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const source = await bridge.request(
        "document.readSource",
        { path: params.path },
        signal === undefined ? {} : { signal },
      );
      if (source.source === "disk") {
        return native.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      if (
        source.source !== "surface-draft"
        || typeof source.base64 !== "string"
        || typeof source.revision !== "string"
      ) {
        throw new Error("Document read source returned an invalid surface snapshot");
      }
      const bytes = Buffer.from(source.base64, "base64");
      const operations: ReadOperations = {
        access: async () => undefined,
        detectImageMimeType: async () => null,
        readFile: async () => bytes,
      };
      const surface = createReadToolDefinition(cwd, {
        ...options,
        operations,
      });
      const result = await surface.execute(toolCallId, params, signal, onUpdate, ctx);
      return {
        ...result,
        details: {
          ...(result.details ?? {}),
          revision: source.revision,
          source: source.source,
        },
      };
    },
  };
  return wrapped as unknown as ToolDefinition;
}
