import type { Theme } from '@/types/theme';

// Dependency-free syntax color projection. This is consumed by ordinary code
// and markdown surfaces, so it must not import the Pierre diff runtime merely
// to construct CSS variables.
export const getMarkdownSyntaxVars = (theme: Theme): Record<string, string> => {
  const base = theme.colors.syntax.base;
  const tokens = theme.colors.syntax.tokens ?? {};
  const status = theme.colors.status;

  return {
    '--md-syntax-foreground': base.foreground,
    '--md-syntax-comment': base.comment,
    '--md-syntax-string': base.string,
    '--md-syntax-number': base.number,
    '--md-syntax-keyword': base.keyword,
    '--md-syntax-operator': base.operator,
    '--md-syntax-function': base.function,
    '--md-syntax-type': base.type,
    '--md-syntax-variable': base.variable,
    '--md-syntax-property': tokens.variableProperty ?? base.variable,
    '--md-syntax-inserted': status.success,
    '--md-syntax-deleted': status.error,
  };
};
