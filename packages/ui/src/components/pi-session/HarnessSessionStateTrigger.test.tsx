import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { HarnessSessionStateTrigger } from './HarnessSessionStateTrigger';

describe('HarnessSessionStateTrigger', () => {
  it('is a narrow-only work-overview affordance with the live activity count', () => {
    const markup = renderToStaticMarkup(<I18nProvider><HarnessSessionStateTrigger count={4} onOpen={vi.fn()} /></I18nProvider>);
    expect(markup).toContain('aria-label="Open work overview"');
    expect(markup).toContain('Work overview');
    expect(markup).toContain('xl:hidden');
    expect(markup).toContain('>4</span>');
  });

  it('surfaces attention without changing the interaction contract', () => {
    const markup = renderToStaticMarkup(<I18nProvider><HarnessSessionStateTrigger count={2} attention onOpen={vi.fn()} /></I18nProvider>);
    expect(markup).toContain('var(--status-warning)');
    expect(markup).toContain('>2</span>');
  });
});
