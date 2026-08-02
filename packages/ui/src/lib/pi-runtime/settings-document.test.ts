import { describe, expect, test } from 'bun:test';
import {
  createPiSettingsChanges,
  formatPiSettingsDocument,
  parsePiSettingsDocument,
} from './settings-document';

describe('Pi settings JSON documents', () => {
  test('builds a top-level patch without rewriting unchanged plugin settings', () => {
    expect(createPiSettingsChanges({
      packages: ['npm:pi-wtf'],
      workspaceHistory: { enabled: 'auto', maxWorkspaces: 10 },
    }, {
      newPlugin: { arbitrary: true },
      workspaceHistory: { enabled: true, maxWorkspaces: 10 },
    })).toEqual({
      remove: ['packages'],
      set: {
        newPlugin: { arbitrary: true },
        workspaceHistory: { enabled: true, maxWorkspaces: 10 },
      },
    });
  });

  test('parses and formats unrestricted JSON objects', () => {
    const settings = parsePiSettingsDocument('{"plugin":{"items":[1,true,null]}}');
    expect(settings).toEqual({ plugin: { items: [1, true, null] } });
    expect(formatPiSettingsDocument(settings)).toBe(
      '{\n  "plugin": {\n    "items": [\n      1,\n      true,\n      null\n    ]\n  }\n}\n',
    );
    expect(() => parsePiSettingsDocument('[]')).toThrow('Pi settings must contain a JSON object');
  });
});
