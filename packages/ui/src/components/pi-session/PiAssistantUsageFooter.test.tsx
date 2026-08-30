import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiUsage } from '@piarium/protocol';
import { I18nProvider } from '@/lib/i18n';
import { PiAssistantUsageFooter } from './PiAssistantUsageFooter';

const renderUsage = (usage: PiUsage): string => renderToStaticMarkup(
  <I18nProvider><PiAssistantUsageFooter usage={usage} /></I18nProvider>,
);

describe('Pi assistant usage footer', () => {
  test('renders the response breakdown with explicit cache read and write fields', () => {
    const markup = renderUsage({
      cacheRead: 8_000,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 2_000,
      output: 500,
      totalTokens: 10_500,
    });
    expect(markup).toContain('Token');
    expect(markup).toContain('Input 2,000');
    expect(markup).toContain('Output 500');
    expect(markup).toContain('Cache Read 8,000');
    expect(markup).toContain('Cache Write 0');
    expect(markup).not.toContain('Reasoning');
    expect(markup).toContain('Total 10,500');
  });

  test('renders nothing when the provider reports no usage', () => {
    expect(renderUsage({
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    })).toBe('');
  });
});
