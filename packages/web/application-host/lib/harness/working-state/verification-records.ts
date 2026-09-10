import path from "node:path";
import type {
  ThreadChildCheckProjection,
  ThreadParentCheckProjection,
  ThreadReviewProjection,
  ThreadVerificationCommandFact,
  ThreadVerificationProjection,
} from "@piarium/protocol";
import type {
  CommandVerificationRecord,
  ParentVerificationBundle,
  ResultReviewRecord,
  ResultVerificationBundle,
  WorkingResult,
} from "./types.js";
import type { WorkingStateStore } from "./working-state-store.js";

const looksBinary = (bytes: Buffer): boolean => bytes.includes(0);

export const cwdUnderRoot = (cwd: string, root: string): boolean => {
  const resolvedCwd = path.resolve(cwd).replace(/\\/g, "/").toLowerCase();
  const resolvedRoot = path.resolve(root).replace(/\\/g, "/").toLowerCase();
  return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}/`);
};

export const inputChangedDuringCommand = (record: {
  startPublishedRevision?: number;
  endPublishedRevision?: number;
  startHeadRevision?: number;
  endHeadRevision?: number;
}): boolean | null => {
  const publishedKnown = record.startPublishedRevision !== undefined && record.endPublishedRevision !== undefined;
  const headKnown = record.startHeadRevision !== undefined && record.endHeadRevision !== undefined;
  if (!publishedKnown && !headKnown) return null;
  return (
    (publishedKnown && record.startPublishedRevision !== record.endPublishedRevision)
    || (headKnown && record.startHeadRevision !== record.endHeadRevision)
  );
};

export const relateCommandToPublish = (
  record: Pick<CommandVerificationRecord, "cwd" | "runId" | "endedAt">,
  context: { worktreePath?: string; runId: string; publishedAt: number },
): CommandVerificationRecord["relationToPublished"] => {
  if (!context.worktreePath || !cwdUnderRoot(record.cwd, context.worktreePath)) return "unbound";
  if (record.runId !== context.runId) return "uncertain";
  if (record.endedAt > context.publishedAt) return "uncertain";
  return "same-run-before-publish";
};

export const bindCommandsToPublishedResult = (input: {
  branchId: string;
  resultRevision: number;
  runId: string;
  worktreePath?: string;
  publishedAt?: number;
  commands: Array<Omit<CommandVerificationRecord, "relationToPublished" | "inputChangedDuringRun" | "inputIdentity"> & {
    startPublishedRevision?: number;
    endPublishedRevision?: number;
    startHeadRevision?: number;
    endHeadRevision?: number;
    branchId?: string;
  }>;
}): ResultVerificationBundle => {
  const publishedAt = input.publishedAt ?? Date.now();
  const checks: CommandVerificationRecord[] = input.commands.map((command) => {
    const relation = relateCommandToPublish(command, {
      runId: input.runId,
      publishedAt,
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    });
    const changed = inputChangedDuringCommand(command);
    const identityKnown = command.startPublishedRevision !== undefined || command.startHeadRevision !== undefined;
    return {
      id: command.id,
      runId: command.runId,
      command: command.command,
      cwd: command.cwd,
      ...(command.envSummary ? { envSummary: command.envSummary } : {}),
      ...(command.commandRunId ? { commandRunId: command.commandRunId } : {}),
      startedAt: command.startedAt,
      endedAt: command.endedAt,
      exitCode: command.exitCode,
      cancelled: command.cancelled,
      ...(command.outputHandle ? { outputHandle: command.outputHandle } : {}),
      ...(command.outputPreview ? { outputPreview: command.outputPreview } : {}),
      inputIdentity: identityKnown
        ? {
            kind: "published-revision" as const,
            ...(command.branchId ? { branchId: command.branchId } : { branchId: input.branchId }),
            ...(command.startPublishedRevision !== undefined ? { startPublishedRevision: command.startPublishedRevision } : {}),
            ...(command.endPublishedRevision !== undefined ? { endPublishedRevision: command.endPublishedRevision } : {}),
            ...(command.startHeadRevision !== undefined ? { startHeadRevision: command.startHeadRevision } : {}),
            ...(command.endHeadRevision !== undefined ? { endHeadRevision: command.endHeadRevision } : {}),
          }
        : {
            kind: "unbound" as const,
            reason: "command started without a readable branch or published revision",
          },
      inputChangedDuringRun: changed,
      relationToPublished: relation,
    };
  });
  const attached = checks.filter((check) => check.relationToPublished === "same-run-before-publish");
  return {
    resultRevision: input.resultRevision,
    branchId: input.branchId,
    recordedAt: publishedAt,
    binding: attached.length > 0 ? "bound" : "uncertain",
    bindingReason: attached.length > 0
      ? "commands observed the live worktree in the same run before publish; published objects were captured later"
      : "no completed command could be bound to this published result",
    checks,
  };
};

const commandFact = (check: CommandVerificationRecord): ThreadVerificationCommandFact => ({
  command: check.command,
  cwd: check.cwd,
  exitCode: check.exitCode,
  cancelled: check.cancelled,
  relation: check.relationToPublished,
  inputChanged: check.inputChangedDuringRun,
  ...(check.outputHandle ? { outputHandle: check.outputHandle } : {}),
});

const allExitedZero = (checks: CommandVerificationRecord[]): boolean | null => {
  if (checks.length === 0) return null;
  return checks.every((check) => check.exitCode === 0 && !check.cancelled);
};

export const projectChildChecks = (bundle: ResultVerificationBundle | undefined): ThreadChildCheckProjection | null => {
  if (!bundle) return null;
  return {
    resultRevision: bundle.resultRevision,
    binding: bundle.binding,
    ...(bundle.bindingReason ? { bindingReason: bundle.bindingReason } : {}),
    commands: bundle.checks.map(commandFact),
    allExitedZero: allExitedZero(bundle.checks.filter((check) => check.relationToPublished === "same-run-before-publish")),
  };
};

export const projectParentChecks = (bundle: ParentVerificationBundle | undefined): ThreadParentCheckProjection | null => {
  if (!bundle) return null;
  return {
    mergedResultRevision: bundle.mergedResultRevision,
    draftUnsaved: bundle.draftUnsaved,
    binding: bundle.binding,
    ...(bundle.note ? { note: bundle.note } : {}),
    commands: bundle.checks.map(commandFact),
    allExitedZero: bundle.draftUnsaved ? null : allExitedZero(bundle.checks),
  };
};

export const projectReview = (
  record: ResultReviewRecord | undefined,
  currentResultRevision?: number,
): ThreadReviewProjection | null => {
  if (!record) return currentResultRevision === undefined ? null : {
    resultRevision: currentResultRevision,
    status: "none",
  };
  if (currentResultRevision !== undefined && record.resultRevision !== currentResultRevision) {
    return { resultRevision: currentResultRevision, status: "none" };
  }
  return {
    resultRevision: record.resultRevision,
    status: record.status,
    ...(record.reviewThreadId ? { reviewThreadId: record.reviewThreadId } : {}),
    ...(record.reviewRunId ? { reviewRunId: record.reviewRunId } : {}),
    ...(record.conclusion ? { conclusion: record.conclusion } : {}),
    ...(record.findings ? { findings: record.findings } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
};

export const projectThreadVerification = (input: {
  currentResultRevision?: number;
  child?: ResultVerificationBundle;
  parent?: ParentVerificationBundle;
  review?: ResultReviewRecord;
}): ThreadVerificationProjection => ({
  ...(input.currentResultRevision !== undefined ? { currentResultRevision: input.currentResultRevision } : {}),
  childChecks: projectChildChecks(input.child),
  parentChecks: projectParentChecks(input.parent),
  review: projectReview(input.review, input.currentResultRevision),
});

const decodeObject = (bytes: Buffer | null, hash: string): string => {
  if (!bytes) return `[missing object ${hash}]`;
  if (looksBinary(bytes)) return `[binary object ${hash} ${bytes.byteLength} bytes]`;
  return bytes.toString("utf8");
};

const formatUnified = (file: string, before: string, after: string): string => {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  if (before === after) return `--- a/${file}\n+++ b/${file}\n`;
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@",
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n");
};

export const formatPublishedResultDiff = async (
  store: Pick<WorkingStateStore, "getObject">,
  result: WorkingResult,
): Promise<string> => {
  if (result.changedPaths.length === 0) return "";
  const sections: string[] = [];
  for (const file of result.changedPaths) {
    const beforeState = result.baseStates[file];
    const afterState = result.pathStates[file];
    const beforeHash = beforeState?.kind === "regular-file" ? beforeState.objectHash : undefined;
    const afterHash = afterState?.kind === "regular-file" ? afterState.objectHash : undefined;
    const before = beforeHash
      ? decodeObject(await store.getObject(beforeHash), beforeHash)
      : beforeState ? `[${beforeState.kind}]` : "";
    const after = afterHash
      ? decodeObject(await store.getObject(afterHash), afterHash)
      : afterState ? `[${afterState.kind}]` : "";
    sections.push(formatUnified(file, before, after));
  }
  return sections.join("\n");
};
