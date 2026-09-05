import { describe, expect, it } from 'vitest';
import { parseHarnessSessionBlockResponse, parseHarnessSessionBlocks } from './harnessBlockPresentation';

describe('harness block presentation', () => {
  it('keeps only complete public block records and sorts by label', () => {
    expect(parseHarnessSessionBlocks({ blocks: [
      { label: 'progress', content: 'working', updatedBy: 'memory-agent', cursorTurn: 4, updatedAt: 2 },
      { label: 'decisions', content: 'use events', updatedBy: 'user', updatedAt: 1 },
      { label: 'broken', content: 4, updatedBy: 'agent', updatedAt: 3 },
    ] })).toEqual([
      { label: 'decisions', content: 'use events', updatedBy: 'user', updatedAt: 1 },
      { label: 'progress', content: 'working', updatedBy: 'memory-agent', cursorTurn: 4, updatedAt: 2 },
    ]);
  });

  it('keeps the Host-resolved branch leaf with its visible block projection', () => {
    expect(parseHarnessSessionBlockResponse({
      branchLeafId: 'leaf-a1',
      blocks: [{ label: 'progress', content: 'current', updatedBy: 'user', updatedAt: 7 }],
    })).toMatchObject({
      branchLeafId: 'leaf-a1',
      blocks: [{ label: 'progress', content: 'current' }],
    });
  });
});
