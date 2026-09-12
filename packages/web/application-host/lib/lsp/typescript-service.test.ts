import fs from 'node:fs';
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

  it('resolves cross-file references through disk reads, and call hierarchy both directions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piarium-ts-refs-'));
    const defFile = path.join(dir, 'def.ts');
    const callerFile = path.join(dir, 'caller.ts');
    fs.writeFileSync(defFile, 'export function uniqueTarget() { return 1; }\n');
    fs.writeFileSync(callerFile, 'import { uniqueTarget } from "./def";\nexport function driver() { return uniqueTarget(); }\n');
    const workspace = createTypescriptLanguageWorkspace();
    try {
      const defText = fs.readFileSync(defFile, 'utf8');
      // Only def.ts is opened; caller.ts reaches the program through the
      // workspace-root scan + disk read, like a real project load.
      workspace.setFile(defFile, defText, 1);
      const defOffset = defText.indexOf('uniqueTarget');
      const sites = workspace.references(defFile, defOffset);
      expect(sites.some((site) => site.fileName.replace(/\\/g, '/').endsWith('caller.ts'))).toBe(true);

      const items = workspace.prepareCallHierarchy(defFile, defOffset);
      expect(items[0]?.name).toBe('uniqueTarget');
      const incoming = workspace.callHierarchyIncoming(defFile, items[0]!.selectionSpan.start);
      expect(incoming.some((call) => call.from.name === 'driver')).toBe(true);

      const callerText = fs.readFileSync(callerFile, 'utf8');
      workspace.setFile(callerFile, callerText, 1);
      const callerItems = workspace.prepareCallHierarchy(callerFile, callerText.indexOf('driver'));
      const outgoing = workspace.callHierarchyOutgoing(callerFile, callerItems[0]!.selectionSpan.start);
      expect(outgoing.some((call) => call.to.name === 'uniqueTarget')).toBe(true);
    } finally {
      workspace.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

