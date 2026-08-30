import React from 'react';
import type { PiUsage } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import {
  projectPiUsagePresentation,
  type PiUsageMetricKey,
} from '@/lib/pi-runtime/usagePresentation';

const LABEL_KEYS: Record<PiUsageMetricKey, I18nKey> = {
  cacheRead: 'contextSidebar.tokens.cacheRead',
  cacheWrite: 'contextSidebar.tokens.cacheWrite',
  cacheWrite1h: 'contextSidebar.tokens.cacheWrite1h',
  input: 'contextSidebar.tokens.input',
  output: 'contextSidebar.tokens.output',
  reasoning: 'contextSidebar.tokens.reasoning',
};

const ICON_NAMES: Record<PiUsageMetricKey, React.ComponentProps<typeof Icon>['name']> = {
  cacheRead: 'database-2',
  cacheWrite: 'archive-stack',
  cacheWrite1h: 'time',
  input: 'arrow-down',
  output: 'arrow-up',
  reasoning: 'brain',
};

const formatNumber = (value: number): string => value.toLocaleString(getCurrentIntlLocale());

const UsageMetric: React.FC<{
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  value: number;
}> = ({ icon, label, value }) => {
  const formatted = formatNumber(value);
  return (
    <span
      className="inline-flex items-center gap-1 tabular-nums"
      title={`${label}: ${formatted}`}
    >
      <Icon name={icon} className="size-3 shrink-0" />
      <span aria-hidden="true">{formatted}</span>
      <span className="sr-only">{label} {formatted}</span>
    </span>
  );
};

export const PiAssistantUsageFooter: React.FC<{ usage: PiUsage }> = ({ usage }) => {
  const { t } = useI18n();
  const presentation = projectPiUsagePresentation(usage);
  if (!presentation) return null;
  return (
    <footer
      className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 typography-micro text-muted-foreground/65"
      aria-label={t('chat.messageUsage.label')}
      data-pi-assistant-usage="true"
      data-pi-turn-usage="true"
    >
      {presentation.metrics.map((metric) => (
        <UsageMetric
          key={metric.key}
          icon={ICON_NAMES[metric.key]}
          label={t(LABEL_KEYS[metric.key])}
          value={metric.value}
        />
      ))}
      {presentation.total !== undefined ? (
        <UsageMetric
          icon="bar-chart-box"
          label={t('contextSidebar.tokens.total')}
          value={presentation.total}
        />
      ) : null}
    </footer>
  );
};
