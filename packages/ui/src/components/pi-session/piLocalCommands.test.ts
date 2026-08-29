import { describe, expect, test } from 'vitest';
import { parsePiLocalCommand } from './piLocalCommands';

describe('Pi local commands', () => {
  test('routes /tree locally and preserves its optional search query', () => {
    expect(parsePiLocalCommand('/tree')).toEqual({ kind: 'tree', query: '' });
    expect(parsePiLocalCommand('  /Tree retry logic')).toEqual({
      kind: 'tree',
      query: 'retry logic',
    });
  });

  test('does not capture ordinary prompts or similarly prefixed commands', () => {
    expect(parsePiLocalCommand('show me the tree')).toBeNull();
    expect(parsePiLocalCommand('/treehouse')).toBeNull();
  });
});

