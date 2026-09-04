import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { HarnessKnowledgeReviewSection } from './HarnessKnowledgeReviewSection';

describe('HarnessKnowledgeReviewSection', () => {
  it('renders editable scoped suggestions and explicit supersedes choices', () => {
    const markup = renderToStaticMarkup(<I18nProvider><HarnessKnowledgeReviewSection
      suggestions={[{
        id: 3,
        scope: 'workspace',
        content: 'Use Bun',
        trigger: 'package management',
        createdAt: 1,
        supersedesCandidates: [{ id: 2, content: 'Use npm', trigger: 'package management' }],
      }]}
      drafts={{ 'workspace:3': { content: 'Use Bun', trigger: 'package management', supersedes: [2] } }}
      busy={false}
      onDraftChange={vi.fn()}
      onAction={vi.fn()}
    /></I18nProvider>);
    expect(markup).toContain('Use Bun');
    expect(markup).toContain('Use npm');
    expect(markup).toContain('type="checkbox" checked=""');
    expect(markup).toContain('Accept');
  });
});
