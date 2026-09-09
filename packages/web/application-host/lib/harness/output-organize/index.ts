import { organizeEslint } from "./eslint.js";
import { organizeGeneric } from "./generic.js";
import { organizeGit } from "./git.js";
import { identifyShellOutput, type OrganizedCommandKind } from "./identify.js";
import { normalizeShellText, organizeBudget, SHELL_DISPLAY_BUDGET } from "./text.js";
import { organizeTsc } from "./tsc.js";
import { organizeVitest } from "./vitest.js";

export type { OrganizedCommandKind } from "./identify.js";
export { identifyFromCommand, identifyShellOutput } from "./identify.js";
export { SHELL_DISPLAY_BUDGET, utf8Bytes } from "./text.js";

export type OrganizedShellOutput = {
  kind: OrganizedCommandKind;
  text: string;
  omitted: boolean;
  partial: boolean;
  recognized: boolean;
};

export function organizeShellOutput(input: {
  command: string;
  output: string;
  complete: boolean;
  exitCode?: number;
  budget?: number;
}): OrganizedShellOutput {
  const normalized = normalizeShellText(input.output);
  const budget = organizeBudget(input.budget ?? SHELL_DISPLAY_BUDGET);
  const dangling = normalized.length > 0 && !input.output.endsWith("\n") && !input.output.endsWith("\r\n");
  const partial = !input.complete || dangling;
  const identified = identifyShellOutput(input.command, normalized);
  const organized = identified.kind === "vitest"
    ? organizeVitest(normalized, budget)
    : identified.kind === "tsc"
      ? organizeTsc(normalized, budget, input.exitCode)
      : identified.kind === "eslint"
        ? organizeEslint(normalized, budget)
        : identified.kind === "git"
          ? organizeGit(normalized, identified.gitSubcommand, budget, input.exitCode)
          : { ...organizeGeneric(normalized, budget), recognized: false };
  const kind = organized.recognized ? identified.kind : "generic";
  return {
    kind,
    text: organized.text,
    omitted: organized.omitted,
    partial,
    recognized: organized.recognized,
  };
}
