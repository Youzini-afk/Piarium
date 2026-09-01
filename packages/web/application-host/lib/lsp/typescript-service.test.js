import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTypescriptLanguageWorkspace } from './typescript-service.js';

describe('typescript language workspace', () => {
  it('reports a type error and hover for an in-memory TypeScript file', () => {
    const workspace = createTypescriptLanguageWorkspace();
    try {
      const fileName = path.join(os.tmpdir(), 'piarium-ts-service.ts');
      workspace.setFile(fileName, 'const greeting: number = "hi";\n', 1);
      const messages = workspace.diagnostics(fileName);
      expect(messages.some((message) => /string|number|assignable/i.test(message))).toBe(true);
      expect(workspace.hover(fileName, 6)).toMatch(/greeting|number|string/i);
      expect(workspace.completion(fileName, 0).length).toBeGreaterThan(0);
    } finally {
      workspace.dispose();
    }
  });
});

