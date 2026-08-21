import { diffArrays } from 'diff';
import type { MergeRegion, MergeRegionDecision } from './types';

type LineEdit = {
  end: number;
  replacement: string[];
  start: number;
};

const lineTokens = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const editsFrom = (ancestor: string[], next: string[]): LineEdit[] => {
  const edits: LineEdit[] = [];
  let baseIndex = 0;
  let pending: LineEdit | null = null;
  const flush = () => {
    if (!pending) return;
    edits.push(pending);
    pending = null;
  };
  for (const change of diffArrays(ancestor, next)) {
    if (!change.added && !change.removed) {
      flush();
      baseIndex += change.value.length;
      continue;
    }
    pending ??= { start: baseIndex, end: baseIndex, replacement: [] };
    if (change.removed) {
      baseIndex += change.value.length;
      pending.end = baseIndex;
    } else if (change.added) {
      pending.replacement.push(...change.value);
    }
  }
  flush();
  return edits;
};

const renderSide = (
  ancestor: string[],
  start: number,
  end: number,
  edits: readonly LineEdit[],
): string => {
  let cursor = start;
  const output: string[] = [];
  for (const edit of edits) {
    output.push(...ancestor.slice(cursor, edit.start), ...edit.replacement);
    cursor = edit.end;
  }
  output.push(...ancestor.slice(cursor, end));
  return output.join('');
};

const appendRegion = (regions: MergeRegion[], region: MergeRegion): void => {
  if (region.kind !== 'conflict' && region.text.length === 0) return;
  const previous = regions.at(-1);
  if (previous && previous.kind === region.kind && previous.kind !== 'conflict' && region.kind !== 'conflict') {
    previous.text += region.text;
    return;
  }
  regions.push(region);
};

export const computeThreeWayMerge = (ancestorText: string, oursText: string, theirsText: string): MergeRegion[] => {
  if (oursText === theirsText) {
    return [{ kind: oursText === ancestorText ? 'same' : 'ours', text: oursText }];
  }
  if (oursText === ancestorText) return [{ kind: 'theirs', text: theirsText }];
  if (theirsText === ancestorText) return [{ kind: 'ours', text: oursText }];

  const ancestor = lineTokens(ancestorText);
  const ours = editsFrom(ancestor, lineTokens(oursText));
  const theirs = editsFrom(ancestor, lineTokens(theirsText));
  const regions: MergeRegion[] = [];
  let oursIndex = 0;
  let theirsIndex = 0;
  let cursor = 0;

  while (oursIndex < ours.length || theirsIndex < theirs.length) {
    const oursNext = ours[oursIndex];
    const theirsNext = theirs[theirsIndex];
    const start = Math.min(oursNext?.start ?? Number.POSITIVE_INFINITY, theirsNext?.start ?? Number.POSITIVE_INFINITY);
    if (cursor < start) appendRegion(regions, { kind: 'same', text: ancestor.slice(cursor, start).join('') });

    let end = start;
    const oursCluster: LineEdit[] = [];
    const theirsCluster: LineEdit[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      const collect = (items: LineEdit[], index: number, target: LineEdit[]): number => {
        let nextIndex = index;
        while (nextIndex < items.length) {
          const edit = items[nextIndex] as LineEdit;
          if (edit.start !== start && edit.start >= end) break;
          target.push(edit);
          end = Math.max(end, edit.end);
          nextIndex += 1;
          changed = true;
        }
        return nextIndex;
      };
      oursIndex = collect(ours, oursIndex, oursCluster);
      theirsIndex = collect(theirs, theirsIndex, theirsCluster);
    }

    const ancestorRegion = ancestor.slice(start, end).join('');
    const oursRegion = renderSide(ancestor, start, end, oursCluster);
    const theirsRegion = renderSide(ancestor, start, end, theirsCluster);
    if (oursRegion === theirsRegion) {
      appendRegion(regions, { kind: oursRegion === ancestorRegion ? 'same' : 'ours', text: oursRegion });
    } else if (oursRegion === ancestorRegion) {
      appendRegion(regions, { kind: 'theirs', text: theirsRegion });
    } else if (theirsRegion === ancestorRegion) {
      appendRegion(regions, { kind: 'ours', text: oursRegion });
    } else {
      appendRegion(regions, { kind: 'conflict', ancestor: ancestorRegion, ours: oursRegion, theirs: theirsRegion });
    }
    cursor = end;
  }

  if (cursor < ancestor.length) {
    appendRegion(regions, { kind: 'same', text: ancestor.slice(cursor).join('') });
  }
  return regions;
};

export const applyMergeDecisions = (
  regions: readonly MergeRegion[],
  decisions: readonly MergeRegionDecision[],
): string => {
  const byIndex = new Map(decisions.map((decision) => [decision.index, decision]));
  return regions.map((region, index) => {
    if (region.kind === 'same' || region.kind === 'ours' || region.kind === 'theirs') return region.text;
    const decision = byIndex.get(index);
    if (!decision) throw new Error(`Merge conflict ${index} has no decision`);
    if (decision.choice === 'ours') return region.ours;
    if (decision.choice === 'theirs') return region.theirs;
    return decision.edited ?? region.ours;
  }).join('');
};
