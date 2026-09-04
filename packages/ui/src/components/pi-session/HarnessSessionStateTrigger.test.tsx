import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { HarnessSessionStateTrigger } from './HarnessSessionStateTrigger';

describe('HarnessSessionStateTrigger', () => {
  it('is a narrow-only, labeled affordance with the live item count', () => {
    const markup = renderToStaticMarkup(<I18nProvider><HarnessSessionStateTrigger count={4} onOpen={vi.fn()} /></I18nProvider>);
    expect(markup).toContain('aria-label="Open session state"');
    expect(markup).toContain('xl:hidden');
    expect(markup).toContain('>4</span>');
  });
});
