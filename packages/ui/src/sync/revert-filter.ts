type RevertMessageLike = {
  id: string;
  parentID?: string;
  time?: {
    created?: number;
    completed?: number;
  };
};

const getParentID = (message: RevertMessageLike): string | undefined => {
  const parentID = message.parentID;
  return typeof parentID === 'string' && parentID.trim().length > 0 ? parentID : undefined;
};

const getMessageTime = (message: RevertMessageLike): number | undefined => {
  const created = message.time?.created;
  if (typeof created === 'number' && Number.isFinite(created)) {
    return created;
  }
  const completed = message.time?.completed;
  if (typeof completed === 'number' && Number.isFinite(completed)) {
    return completed;
  }
  return undefined;
};

export function partitionMessagesByRevert<T extends RevertMessageLike>(
  messages: readonly T[],
  revertMessageID: string | undefined,
): { kept: T[]; removed: T[] } {
  if (!revertMessageID) {
    return { kept: messages as T[], removed: [] };
  }

  const targetIndex = messages.findIndex((message) => message.id === revertMessageID);
  const target = targetIndex >= 0 ? messages[targetIndex] : undefined;
  const targetTime = target ? getMessageTime(target) : undefined;
  const removedIds = new Set<string>([revertMessageID]);

  if (target && typeof targetTime === 'number') {
    for (const message of messages) {
      const messageTime = getMessageTime(message);
      if (typeof messageTime === 'number' && messageTime >= targetTime) {
        removedIds.add(message.id);
      }
    }
  } else if (targetIndex >= 0) {
    for (let index = targetIndex; index < messages.length; index += 1) {
      removedIds.add(messages[index].id);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      if (removedIds.has(message.id)) {
        continue;
      }
      const parentID = getParentID(message);
      if (parentID && removedIds.has(parentID)) {
        removedIds.add(message.id);
        changed = true;
      }
    }
  }

  const kept: T[] = [];
  const removed: T[] = [];
  for (const message of messages) {
    if (removedIds.has(message.id)) {
      removed.push(message);
    } else {
      kept.push(message);
    }
  }

  return { kept, removed };
}

export function getMessagesBeforeRevert<T extends RevertMessageLike>(
  messages: readonly T[],
  revertMessageID: string | undefined,
): T[] {
  return partitionMessagesByRevert(messages, revertMessageID).kept;
}

export function sortMessagesForRevert<T extends RevertMessageLike>(messages: readonly T[]): T[] {
  return [...messages].sort((left, right) => {
    const leftTime = getMessageTime(left);
    const rightTime = getMessageTime(right);
    if (typeof leftTime === 'number' && typeof rightTime === 'number' && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (typeof leftTime === 'number' && typeof rightTime !== 'number') return -1;
    if (typeof leftTime !== 'number' && typeof rightTime === 'number') return 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}
