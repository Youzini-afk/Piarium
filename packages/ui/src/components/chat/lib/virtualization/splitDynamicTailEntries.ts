export function splitDynamicTailEntries<T>(input: {
  allEntries: T[];
  staticRenderEntries: T[];
  trailingStreamingEntry?: T;
  activeStreamingMessageId?: string | null;
  shouldSplitDynamicTail: boolean;
  dynamicTailCount: number;
}): { historyEntries: T[]; dynamicTailEntries: T[] } {
  const {
    allEntries,
    staticRenderEntries,
    trailingStreamingEntry,
    activeStreamingMessageId,
    shouldSplitDynamicTail,
    dynamicTailCount,
  } = input;

  if (shouldSplitDynamicTail) {
    return {
      historyEntries: allEntries.slice(0, -dynamicTailCount),
      dynamicTailEntries: allEntries.slice(-dynamicTailCount),
    };
  }

  if (trailingStreamingEntry && activeStreamingMessageId) {
    return {
      historyEntries: staticRenderEntries,
      dynamicTailEntries: [trailingStreamingEntry],
    };
  }

  return {
    historyEntries: allEntries,
    dynamicTailEntries: [],
  };
}
