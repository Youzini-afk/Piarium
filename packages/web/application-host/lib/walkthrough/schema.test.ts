import { describe, expect, it } from 'vitest';
import { normalizeWalkthrough, parseModelJson } from './schema.js';

const required = <Value>(value: Value | undefined, label: string): Value => {
  if (value === undefined) throw new Error(`Missing fixture value: ${label}`);
  return value;
};

const ALIASES = new Map([
  ['h1', 'working:src/a.ts:aaaa1111'],
  ['h2', 'working:src/a.ts:bbbb2222'],
  ['h3', 'working:src/b.ts:cccc3333'],
]);

const walkthrough = (chapters: unknown[]): Record<string, unknown> => ({ title: 'Change', focus: 'why', chapters });

describe('normalizeWalkthrough', () => {
  it('maps aliases to real hunk ids and assigns stable local ids', () => {
    const result = normalizeWalkthrough(walkthrough([
      {
        title: 'Data',
        icon: 'doc',
        blurb: 'shape first',
        stops: [
          { title: 'New field', hunks: ['h1', 'h2'], importance: 'critical', prose: 'Adds a field.' },
        ],
      },
    ]), ALIASES);

    const chapter = required(result.chapters[0], 'chapter');
    expect(chapter.id).toBe('chapter-1');
    expect(chapter.stops[0]).toMatchObject({
      id: 'stop-1-1',
      hunkIds: ['working:src/a.ts:aaaa1111', 'working:src/a.ts:bbbb2222'],
      importance: 'critical',
    });
  });

  it('drops invented aliases instead of rendering a broken anchor', () => {
    const result = normalizeWalkthrough(walkthrough([
      {
        title: 'Data',
        icon: 'doc',
        blurb: '',
        stops: [
          { title: 'Mixed', hunks: ['h1', 'h99', 'nonsense'], importance: 'normal', prose: 'Something.' },
        ],
      },
    ]), ALIASES);

    expect(required(required(result.chapters[0], 'chapter').stops[0], 'stop').hunkIds).toEqual(['working:src/a.ts:aaaa1111']);
    expect(result.droppedAnchors).toBe(2);
  });

  it('anchors each hunk to a single stop', () => {
    const result = normalizeWalkthrough(walkthrough([
      {
        title: 'Data',
        icon: 'doc',
        blurb: '',
        stops: [
          { title: 'First', hunks: ['h1'], importance: 'normal', prose: 'One.' },
          { title: 'Second', hunks: ['h1', 'h2'], importance: 'normal', prose: 'Two.' },
        ],
      },
    ]), ALIASES);

    const chapter = required(result.chapters[0], 'chapter');
    expect(required(chapter.stops[0], 'first stop').hunkIds).toEqual(['working:src/a.ts:aaaa1111']);
    expect(required(chapter.stops[1], 'second stop').hunkIds).toEqual(['working:src/a.ts:bbbb2222']);
  });

  it('discards stops left with no anchor or no prose', () => {
    const result = normalizeWalkthrough(walkthrough([
      {
        title: 'Data',
        icon: 'doc',
        blurb: '',
        stops: [
          { title: 'Ghost', hunks: ['h99'], importance: 'normal', prose: 'About nothing.' },
          { title: 'Silent', hunks: ['h1'], importance: 'normal', prose: '   ' },
          { title: 'Real', hunks: ['h2'], importance: 'normal', prose: 'Actual explanation.' },
        ],
      },
    ]), ALIASES);

    expect(required(result.chapters[0], 'chapter').stops.map((stop) => stop.title)).toEqual(['Real']);
  });

  it('rejects a response whose stops all fall away', () => {
    expect(() => normalizeWalkthrough(walkthrough([
      { title: 'Empty', icon: 'doc', blurb: '', stops: [{ title: 'Ghost', hunks: ['h99'], importance: 'normal', prose: 'x' }] },
    ]), ALIASES)).toThrow('no usable stops');
  });

  it('preserves chapter titles and falls back on unknown enums', () => {
    const result = normalizeWalkthrough(walkthrough([
      {
        title: 'An extremely long chapter title that will not fit the column',
        icon: 'rocket',
        blurb: '',
        stops: [{ title: 'A', hunks: ['h1'], importance: 'urgent', prose: 'Text.' }],
      },
    ]), ALIASES);

    const chapter = required(result.chapters[0], 'chapter');
    expect(chapter.title).toBe('An extremely long chapter title that will not fit the column');
    expect(chapter.icon).toBe('doc');
    expect(required(chapter.stops[0], 'stop').importance).toBe('normal');
  });

  it('does not impose a product-arbitrary stop cap', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      title: `Stop ${index}`,
      hunks: [['h1', 'h2', 'h3'][index % 3]],
      importance: 'normal',
      prose: 'Text.',
    }));

    const result = normalizeWalkthrough(
      walkthrough([{ title: 'All', icon: 'doc', blurb: '', stops: many }]),
      ALIASES,
    );

    const total = result.chapters.reduce((sum, chapter) => sum + chapter.stops.length, 0);
    // Only three aliases exist and each hunk is anchored once, so the actual
    // data invariant —not an arbitrary UI count —bounds this fixture.
    expect(total).toBe(3);
  });
});

describe('parseModelJson', () => {
  it('parses a clean object', () => {
    expect(parseModelJson('{"title":"x"}')).toEqual({ title: 'x' });
  });

  it('unwraps a fenced block', () => {
    expect(parseModelJson('```json\n{"title":"x"}\n```')).toEqual({ title: 'x' });
  });

  it('recovers an object followed by stray prose', () => {
    expect(parseModelJson('{"title":"x"}\n\nHope that helps!')).toEqual({ title: 'x' });
  });

  it('fails loudly on unusable output', () => {
    expect(() => parseModelJson('')).toThrow('empty response');
    expect(() => parseModelJson('no json at all')).toThrow('no JSON object');
    expect(() => parseModelJson('{"broken":')).toThrow('not valid JSON');
  });
});
