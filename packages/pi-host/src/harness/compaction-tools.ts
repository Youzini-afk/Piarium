import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import type {
  CompactionHistoryParams,
  ExperimentArtifactReadParams,
  ExperimentLogsParams,
  HarnessMethod,
} from "@varin/protocol";
import { COMPACTION_QUERY_METHODS } from "@varin/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";

/**
 * Read-only query executors for the compaction worker (D-314).
 *
 * Every call goes through the real harness bridge → broker → Host service
 * path under an auxiliary actor restricted to COMPACTION_QUERY_METHODS
 * (protocol-owned allowlist, also enforced by the Host router). None of
 * these consume the parent session's observation cursors or receipts.
 */
export { COMPACTION_QUERY_METHODS };

const HistoryParams = Type.Object({
  query: Type.Optional(Type.String({ description: "Case-insensitive substring matched against each entry's text." })),
  path: Type.Optional(Type.String({ description: "Restrict matches to entries whose text mentions this path fragment." })),
  entry: Type.Optional(Type.String({ description: "Entry id to read directly; combine with before/after for neighbours." })),
  before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
  after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Matching-entry offset; use nextOffset from the previous result." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const OutputParams = Type.Object({
  handle: Type.String({ description: "Output handle recorded in the history, e.g. a truncated tool result or shell output." }),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  length: Type.Optional(Type.Integer({ minimum: 1 })),
});

const RecordsParams = Type.Object({
  kind: Type.Union([
    Type.Literal("threads"),
    Type.Literal("experiments"),
    Type.Literal("followups"),
    Type.Literal("scheduled"),
  ], { description: "Which record family to read." }),
  id: Type.Optional(Type.String({
    description: "Record id (thread/experiment attempt/follow-up/scheduled task). Omit to list.",
  })),
  part: Type.Optional(Type.Union([Type.Literal("logs"), Type.Literal("artifact")], {
    description: "experiments only: read an attempt's collected logs or a named artifact instead of the summary view.",
  })),
  artifactId: Type.Optional(Type.String({ description: "Artifact id for part=artifact." })),
  what: Type.Optional(Type.Union([
    Type.Literal("blocks"),
    Type.Literal("report"),
    Type.Literal("steps"),
    Type.Literal("transcript"),
  ], { description: "threads only: select the status, report, steps, or transcript view." })),
  runId: Type.Optional(Type.String({ description: "threads only: select a retained execution Run." })),
  resultRevision: Type.Optional(Type.Integer({ minimum: 1, description: "threads only: select a published result revision." })),
  stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr")])),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  length: Type.Optional(Type.Integer({ minimum: 1 })),
  since: Type.Optional(Type.Integer({ minimum: 0 })),
  entry: Type.Optional(Type.String({ description: "threads/transcript: entry id to read with neighbours." })),
  before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
  after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  query: Type.Optional(Type.String({ description: "threads/transcript: case-insensitive history search." })),
  path: Type.Optional(Type.String({ description: "threads/transcript: restrict history matches to a path fragment." })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
});

const text = (value: string): AgentToolResult<Record<string, never>> => ({
  content: [{ type: "text", text: value }],
  details: {},
});

const failure = (error: unknown): AgentToolResult<Record<string, never>> =>
  text(`Query failed: ${error instanceof Error ? error.message : String(error)}`);

/** Schema-only view for request-shape estimation and the wire prefix. */
export function compactionQueryToolSchemas(): NonNullable<Context["tools"]> {
  return [
    {
      name: "history",
      description: "Search or read this session's authorized history inside the frozen range. "
        + "Locate by query/path or read one entry with neighbours; page via offset/nextOffset.",
      parameters: HistoryParams,
    },
    {
      name: "output",
      description: "Read a recorded tool output or artifact body by handle, paged by offset/length.",
      parameters: OutputParams,
    },
    {
      name: "records",
      description: "List or read related task records: threads, experiment attempts, follow-ups, scheduled tasks. "
        + "Live state is an observation made now, not a fact of the replaced history.",
      parameters: RecordsParams,
    },
  ];
}

export function createCompactionQueryTools(
  bridge: HostServicesBridge,
  onQuery?: () => void,
): AgentTool[] {
  const call = async <M extends HarnessMethod>(
    method: M,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> => {
    onQuery?.();
    return bridge.request(
      method,
      params as never,
      signal ? { signal } : undefined,
    );
  };

  return [
    {
      name: "history",
      label: "History",
      description: compactionQueryToolSchemas()[0]!.description,
      parameters: HistoryParams,
      executionMode: "parallel",
      execute: async (_id, params, signal) => {
        onQuery?.();
        try {
          const result = await bridge.request(
            "compaction.history",
            params as CompactionHistoryParams,
            signal ? { signal } : undefined,
          );
          const content = result.content.map((part) =>
            part.type === "image"
              ? { type: "image" as const, data: part.data, mimeType: part.mimeType }
              : { type: "text" as const, text: part.text });
          return { content, details: result.details as Record<string, never> };
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "output",
      label: "Output",
      description: compactionQueryToolSchemas()[1]!.description,
      parameters: OutputParams,
      executionMode: "parallel",
      execute: async (_id, params, signal) => {
        try {
          const slice = await call("output.read", params as Record<string, unknown>, signal) as {
            text: string; offset: number; total: number; eof: boolean; nextOffset: number;
          };
          return text(`${slice.text}\n[output slice ${slice.offset}–${slice.offset + slice.text.length} of ${slice.total}${slice.eof ? " · end" : ` · nextOffset=${slice.nextOffset}`}]`);
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "records",
      label: "Records",
      description: compactionQueryToolSchemas()[2]!.description,
      parameters: RecordsParams,
      executionMode: "parallel",
      execute: async (_id, params, signal) => {
        try {
          const { kind, id, part, artifactId, what, runId, resultRevision, stream, offset, length, since, entry, before, after, limit, query, path, maxBytes } =
            params as Record<string, unknown> & { kind: string; id?: string; part?: string; artifactId?: string; stream?: "stdout" | "stderr"; offset?: number; maxBytes?: number };
          let result: unknown;
          switch (kind) {
            case "threads":
              result = id === undefined
                ? await call("thread.list", { full: true }, signal)
                : await call("thread.read", {
                    threadId: id,
                    ...(what === undefined ? {} : { what }),
                    ...(runId === undefined ? {} : { runId }),
                    ...(resultRevision === undefined ? {} : { resultRevision }),
                    ...(since === undefined ? {} : { since }),
                    ...(offset === undefined ? {} : { offset }),
                    ...(length === undefined && maxBytes === undefined ? {} : { length: length ?? maxBytes }),
                    ...(entry === undefined ? {} : { entry }),
                    ...(before === undefined ? {} : { before }),
                    ...(after === undefined ? {} : { after }),
                    ...(limit === undefined ? {} : { limit }),
                    ...(query === undefined ? {} : { query }),
                    ...(path === undefined ? {} : { path }),
                  }, signal);
              break;
            case "experiments":
              if (id === undefined) {
                result = await call("experiment.list", {}, signal);
              } else if (part === "logs") {
                result = await call("experiment.logs", { attemptId: id, ...(stream === undefined ? {} : { stream }), ...(offset === undefined ? {} : { offset }), ...(maxBytes === undefined ? {} : { maxBytes }) } satisfies ExperimentLogsParams as Record<string, unknown>, signal);
              } else if (part === "artifact") {
                if (typeof artifactId !== "string" || artifactId.length === 0) {
                  return text("records: part=artifact requires artifactId");
                }
                result = await call("experiment.artifact", { attemptId: id, artifactId, ...(offset === undefined ? {} : { offset }), ...(maxBytes === undefined ? {} : { maxBytes }) } satisfies ExperimentArtifactReadParams as Record<string, unknown>, signal);
              } else {
                result = await call("experiment.get", { attemptId: id }, signal);
              }
              break;
            case "followups":
              result = id === undefined
                ? await call("followup.list", { includeInactive: true }, signal)
                : await call("followup.get", { id }, signal);
              break;
            case "scheduled":
              result = id === undefined
                ? await call("schedule.list", {}, signal)
                : await call("schedule.get", { taskId: id }, signal);
              break;
          }
          return text(JSON.stringify({
            observedAt: new Date().toISOString(),
            source: "live",
            record: result,
          }, null, 2));
        } catch (error) {
          return failure(error);
        }
      },
    },
  ];
}
