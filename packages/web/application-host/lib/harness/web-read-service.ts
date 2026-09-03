import type { WebReadResult, FetchResult } from "@piarium/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";

export interface ReaderModelRequest {
  systemPrompt: string;
  userPrompt: string;
  providerId: string;
  modelId: string;
}

export interface WebReadDeps {
  fetch: (url: string, ctx: { workspaceId: string; render?: boolean }) => Promise<FetchResult>;
  readerRequest: (request: ReaderModelRequest) => Promise<string>;
  readerModel: { providerId: string; modelId: string } | null;
}

const READER_SYSTEM_PROMPT = "You answer questions strictly from the provided page content. Quote line references. If the content does not contain the answer, say so.";

export function createWebReadService(deps: WebReadDeps): HarnessService<"web.read"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (!ctx.workspaceId) {
        return { answer: "no workspace", sources: [] };
      }
      if (!deps.readerModel) {
        return { answer: "reader unavailable: no reader model configured", sources: [] };
      }

      // Fetch the page
      const fetchResult = await deps.fetch(params.url, {
        workspaceId: ctx.workspaceId,
        ...(params.render !== undefined ? { render: params.render } : {}),
      });

      if (fetchResult.status !== "ok") {
        return { answer: `fetch failed: ${fetchResult.status}`, sources: [] };
      }

      // Ask the reader model
      const userPrompt = `Page content from ${fetchResult.finalUrl}:\n\n${fetchResult.markdown}\n\nQuestion: ${params.prompt}`;
      const answer = await deps.readerRequest({
        systemPrompt: READER_SYSTEM_PROMPT,
        userPrompt,
        providerId: deps.readerModel.providerId,
        modelId: deps.readerModel.modelId,
      });

      return {
        answer,
        sources: [fetchResult.finalUrl],
      };
    },
  };
}
