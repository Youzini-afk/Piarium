import type {
  PiAssistantMessage,
  PiSessionMessageEntry,
  PiUserMessage,
  SessionTreeNode,
  SessionTreeResult,
} from '@piarium/protocol';

export interface PiSessionTreeItem {
  active: boolean;
  branchDepth: number;
  current: boolean;
  entry: PiSessionMessageEntry;
  label?: string;
  labelTimestamp?: string;
  text: string;
}

const isNavigableMessage = (
  entry: SessionTreeNode['entry'],
): entry is PiSessionMessageEntry & { message: PiAssistantMessage | PiUserMessage } => (
  entry.type === 'message'
  && (entry.message.role === 'user' || entry.message.role === 'assistant')
);

const messageText = (entry: PiSessionMessageEntry): string => {
  const { message } = entry;
  if (message.role === 'user') {
    return (typeof message.content === 'string'
      ? message.content
      : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')).trim();
  }
  if (message.role === 'assistant') {
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return '';
};

/**
 * Project Pi's entry-by-entry session tree into message rows. Indentation tracks
 * branch splits, not total message ancestry, so a long linear conversation does
 * not drift horizontally across the dialog.
 */
export const projectPiSessionTree = (result: SessionTreeResult): PiSessionTreeItem[] => {
  const nodes = new Map<string, SessionTreeNode>();
  const collect = (items: readonly SessionTreeNode[]) => {
    for (const node of items) {
      nodes.set(node.entry.id, node);
      collect(node.children);
    }
  };
  collect(result.tree);

  const activePath = new Set<string>();
  let cursor = result.leafId;
  while (cursor) {
    if (activePath.has(cursor)) break;
    activePath.add(cursor);
    cursor = nodes.get(cursor)?.entry.parentId ?? null;
  }

  let currentMessageId: string | null = null;
  cursor = result.leafId;
  while (cursor) {
    const node = nodes.get(cursor);
    if (!node) break;
    if (isNavigableMessage(node.entry)) {
      currentMessageId = node.entry.id;
      break;
    }
    cursor = node.entry.parentId;
  }

  const projected: PiSessionTreeItem[] = [];
  const visit = (node: SessionTreeNode, branchDepth: number) => {
    if (isNavigableMessage(node.entry)) {
      projected.push({
        active: activePath.has(node.entry.id),
        branchDepth,
        current: node.entry.id === currentMessageId,
        entry: node.entry,
        ...(node.label === undefined ? {} : { label: node.label }),
        ...(node.labelTimestamp === undefined ? {} : { labelTimestamp: node.labelTimestamp }),
        text: messageText(node.entry),
      });
    }

    const activeChild = node.children.find((child) => activePath.has(child.entry.id));
    const primaryChild = activeChild ?? node.children[0];
    for (const child of node.children) {
      visit(child, child === primaryChild ? branchDepth : branchDepth + 1);
    }
  };
  for (const root of result.tree) visit(root, 0);
  return projected;
};

