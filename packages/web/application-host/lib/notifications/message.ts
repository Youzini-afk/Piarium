const DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH = 250;

const resolvePositiveNumber = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
};

const normalizeNotificationPlainText = (text: unknown): string => {
  if (typeof text !== 'string') {
    return '';
  }

  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^[\t ]*[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

export const truncateNotificationText = (
  text: unknown,
  maxLength: unknown = DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH,
): string => {
  if (typeof text !== 'string') {
    return '';
  }

  const safeMaxLength = resolvePositiveNumber(maxLength, DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH);
  if (text.length <= safeMaxLength) {
    return text;
  }

  return `${text.slice(0, safeMaxLength)}...`;
};

export const prepareNotificationLastMessage = async ({
  message,
  settings,
}: {
  message: unknown;
  settings?: Record<string, unknown> | null | undefined;
}): Promise<string> => {
  const originalMessage = typeof message === 'string' ? message : '';
  if (!originalMessage) {
    return '';
  }

  const maxLastMessageLength = resolvePositiveNumber(settings?.maxLastMessageLength, DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH);
  const plainTextMessage = normalizeNotificationPlainText(originalMessage);
  return truncateNotificationText(plainTextMessage, maxLastMessageLength);
};
