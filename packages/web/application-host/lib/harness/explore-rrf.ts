/**
 * File-level reciprocal rank fusion for explore read scheduling (D-170).
 * RRF eats ranks only, one term per source, k=60. A missing source is a
 * missing term. This is not D-145: no raw group weights mixed in, no
 * path-order-as-rank. File scheduling and unit selection build their own ranks
 * from their own evidence before calling this helper.
 */

export const EXPLORE_RRF_K = 60;

export function reciprocalRank(rank: number, k: number = EXPLORE_RRF_K): number {
  return 1 / (k + rank);
}

export function fuseFileRanks(ranks: { lexical?: number; semantic?: number }): number {
  let score = 0;
  if (ranks.lexical !== undefined) score += reciprocalRank(ranks.lexical);
  if (ranks.semantic !== undefined) score += reciprocalRank(ranks.semantic);
  return score;
}
