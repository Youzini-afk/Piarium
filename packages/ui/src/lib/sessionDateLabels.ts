import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) => (
  formatMessage(useI18nStore.getState().dictionary, key, params)
);

const sameDay = (left: Date, right: Date): boolean => (
  left.getFullYear() === right.getFullYear()
  && left.getMonth() === right.getMonth()
  && left.getDate() === right.getDate()
);

const formatDateLabel = (value: string | number): string => {
  const targetDate = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (sameDay(targetDate, today)) return t('common.date.today');
  if (sameDay(targetDate, yesterday)) return t('common.date.yesterday');
  return targetDate.toLocaleDateString(getCurrentIntlLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).replace(',', '');
};

export const formatSessionDateLabel = (updatedMs: number): string => {
  const today = new Date();
  const updatedDate = new Date(updatedMs);
  if (sameDay(updatedDate, today)) {
    const diff = Date.now() - updatedMs;
    if (diff < 60_000) return t('common.relative.justNow');
    if (diff < 3_600_000) {
      return t('common.relative.minutesAgoShort', { count: Math.floor(diff / 60_000) });
    }
    return t('common.relative.hoursAgoShort', { count: Math.floor(diff / 3_600_000) });
  }
  return formatDateLabel(updatedMs);
};

export const formatSessionCompactDateLabel = (updatedMs: number): string => {
  const diff = Math.max(0, Date.now() - updatedMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  if (diff < week) return t('common.relative.daysAgoCompact', { count: Math.floor(diff / day) });
  if (diff < 5 * week) return t('common.relative.weeksAgoCompact', { count: Math.floor(diff / week) });
  if (diff < year) return `${Math.floor(diff / month)}mo`;
  return t('common.relative.yearsAgoCompact', { count: Math.floor(diff / year) });
};
