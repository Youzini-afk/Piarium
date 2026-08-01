import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('model selector compact layout', () => {
  test('clips long provider/model labels inside the selector trigger', () => {
    const source = readFileSync(resolve(testDir, 'ModelSelector.tsx'), 'utf8');
    const triggerLabelClasses = source
      .match(/className="([^"]*min-w-0[^"]*truncate[^"]*)">\{triggerLabel\}<\/span>/)?.[1] ?? '';

    expect(source).toContain('overflow-hidden');
    expect(triggerLabelClasses).toContain('min-w-0');
    expect(triggerLabelClasses).toContain('truncate');
  });

  test('does not show remote provider logo images before they finish loading', () => {
    const source = readFileSync(resolve(testDir, '../../ui/ProviderLogo.tsx'), 'utf8');

    expect(source).toContain('onLoad');
    expect(source).toContain('opacity-0');
  });

  test('settings compact model editors wrap instead of overlapping the manual input', () => {
    const openAgentSource = readFileSync(resolve(testDir, '../openagent/OpenAgentPage.tsx'), 'utf8');
    const magicContextSource = readFileSync(resolve(testDir, '../magic-context/MagicContextPage.tsx'), 'utf8');

    expect(openAgentSource).toContain('flex-wrap');
    expect(magicContextSource).toContain('flex-wrap');
    expect(openAgentSource).toContain('min-w-[120px] max-w-[210px] flex-1');
    expect(magicContextSource).toContain('min-w-[120px] max-w-[260px] flex-1');
  });
});
