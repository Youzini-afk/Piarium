import { describe, expect, it } from 'vitest';
import {
  decodeWorkspaceWitness,
  encodeWorkspaceWitness,
  sameWorkspaceContentWitness,
} from './witness.js';

describe('workspace recovery witnesses', () => {
  it('round-trips an opaque witness reference and compares only content identity', () => {
    const witness = { epoch: 2, mutationRevision: 8, writerRevision: 13 };
    expect(decodeWorkspaceWitness(encodeWorkspaceWitness(witness))).toEqual(witness);
    expect(sameWorkspaceContentWitness(witness, { ...witness, writerRevision: 99 })).toBe(true);
    expect(sameWorkspaceContentWitness(witness, { ...witness, mutationRevision: 9 })).toBe(false);
  });

  it('leaves ordinary snapshot ids alone and rejects malformed witness references', () => {
    expect(decodeWorkspaceWitness('snapshot-id')).toBeNull();
    expect(() => decodeWorkspaceWitness('piarium-witness:v1:1:x:3')).toThrow(/malformed/i);
  });
});
