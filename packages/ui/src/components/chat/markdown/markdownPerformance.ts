export const FILE_REFERENCE_ANNOTATION_MAX_CHARS = 80_000;
export const CONSTRAINED_FILE_REFERENCE_ANNOTATION_MAX_CHARS = 40_000;
export const RICH_MARKDOWN_FIRST_PAINT_MAX_CHARS = 120_000;
export const CONSTRAINED_RICH_MARKDOWN_FIRST_PAINT_MAX_CHARS = 60_000;

export const shouldEnableFileReferenceAnnotations = ({
  enabled,
  isStreaming,
  contentLength,
  isConstrainedRuntime,
}: {
  enabled: boolean;
  isStreaming: boolean;
  contentLength: number;
  isConstrainedRuntime: boolean;
}): boolean => {
  if (!enabled || isStreaming) return false;
  const limit = isConstrainedRuntime
    ? CONSTRAINED_FILE_REFERENCE_ANNOTATION_MAX_CHARS
    : FILE_REFERENCE_ANNOTATION_MAX_CHARS;
  return contentLength <= limit;
};

export const shouldUseRichMarkdownFirstPaint = ({
  contentLength,
  isConstrainedRuntime,
}: {
  contentLength: number;
  isConstrainedRuntime: boolean;
}): boolean => {
  const limit = isConstrainedRuntime
    ? CONSTRAINED_RICH_MARKDOWN_FIRST_PAINT_MAX_CHARS
    : RICH_MARKDOWN_FIRST_PAINT_MAX_CHARS;
  return contentLength <= limit;
};
