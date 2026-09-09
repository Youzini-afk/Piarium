import type { ShellOutputOrganization } from "@piarium/protocol";
import type { OutputStore } from "../output-store.js";
import { organizeShellOutput } from "./index.js";

export function presentOrganizedOutput(input: {
  command: string;
  output: string;
  complete: boolean;
  exitCode?: number;
  existingHandle?: string | null;
  store?: OutputStore;
  sessionId?: string;
}): {
  display: string;
  organized: ShellOutputOrganization;
  handle: string | null;
} {
  const organized = organizeShellOutput({
    command: input.command,
    output: input.output,
    complete: input.complete,
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
  });
  let handle = input.existingHandle ?? null;
  const changed = organized.text !== input.output || organized.omitted;
  if (changed && handle === null && input.complete && input.store && input.sessionId) {
    handle = input.store.store(input.sessionId, input.output, "bash").ref.handle;
  }
  return {
    display: organized.text,
    organized: {
      kind: organized.kind,
      omitted: organized.omitted,
      partial: organized.partial,
    },
    handle,
  };
}
