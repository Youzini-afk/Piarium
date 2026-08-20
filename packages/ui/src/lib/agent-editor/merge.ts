import type { MergeRegion, MergeRegionDecision } from './types';

export const computeThreeWayMerge = (ancestor: string, ours: string, theirs: string): MergeRegion[] => {
  if (ours === theirs) {
    return [{ kind: ours === ancestor ? 'same' : 'ours', text: ours }];
  }
  if (ours === ancestor) return [{ kind: 'theirs', text: theirs }];
  if (theirs === ancestor) return [{ kind: 'ours', text: ours }];
  return [{ kind: 'conflict', ancestor, ours, theirs }];
};

export const applyMergeDecisions = (
  regions: readonly MergeRegion[],
  decisions: readonly MergeRegionDecision[],
): string => {
  const byIndex = new Map(decisions.map((decision) => [decision.index, decision]));
  return regions.map((region, index) => {
    if (region.kind === 'same' || region.kind === 'ours' || region.kind === 'theirs') return region.text;
    const decision = byIndex.get(index);
    if (!decision || decision.choice === 'ours') return region.ours;
    if (decision.choice === 'theirs') return region.theirs;
    return decision.edited ?? region.ours;
  }).join('\n');
};
