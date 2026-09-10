import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('Knowledge settings page', () => {
  test('uses the authenticated catalog routes and workbench workspace identity', () => {
    const source = readFileSync(new URL('./KnowledgeSettingsPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('SettingsPageLayout');
    expect(source).toContain('useWorkbenchWorkspace');
    expect(source).toContain('loadKnowledgeCatalog');
    expect(source).toContain('saveKnowledgeCatalogItem');
    expect(source).toContain('retireKnowledgeCatalogItem');
    expect(source).toContain('reviewKnowledgeCatalogItem');
    expect(source).toContain('loadKnowledgeChain');
    expect(source).toContain('subscribePiariumEvents');
    expect(source).toContain('settings.page.knowledge.title');
    expect(source).not.toContain('draftWithModel');
    expect(source).not.toContain('completeSimple');
  });
});
