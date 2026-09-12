/**
 * Merkle state map for WorkingState path states (D-245).
 *
 * Path→RecoveryState maps are stored as a persistent hash trie over path
 * segments. A node carries an optional `self` state — a path can be an entry
 * and a parent at once (`a` and `a/b` may coexist in a map, e.g. a file that
 * became a directory) — plus content-addressed children. Unchanged subtrees
 * share nodes across branches, results, and draft baselines, so a publish
 * touching k paths produces k×depth new nodes instead of a full map copy.
 * The root hash is the map's complete content identity: comparing roots is
 * comparing trees, and `trieDiff` skips shared subtrees outright.
 */

import { createHash } from "node:crypto";
import type { RecoveryState } from "./types.js";
import { stateIdentity } from "../../recovery/journal-files.js";

export interface StateTrieNode {
  /** Segment name → child node hash. */
  children: Record<string, string>;
  /** The state stored at this path, when the path is itself an entry. */
  self?: RecoveryState;
}

/** A self-contained map value: root hash plus every node reachable from it. */
export interface StateTrie {
  root: string;
  nodes: Record<string, StateTrieNode>;
}

const nodeHash = (node: StateTrieNode): string => {
  const hash = createHash("sha256");
  hash.update("dir\0");
  for (const name of Object.keys(node.children).sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(node.children[name]!);
    hash.update("\0");
  }
  hash.update("self\0");
  hash.update(node.self ? stateIdentity(node.self) : "");
  return hash.digest("hex");
};

const EMPTY_NODE: StateTrieNode = { children: {} };
const EMPTY_ROOT = nodeHash(EMPTY_NODE);

export const EMPTY_STATE_TRIE: StateTrie = { root: EMPTY_ROOT, nodes: { [EMPTY_ROOT]: EMPTY_NODE } };

const lookupNode = (nodes: Record<string, StateTrieNode>, hash: string): StateTrieNode => {
  const node = nodes[hash];
  if (!node) throw new Error("State trie node is missing");
  return node;
};

/**
 * Set `path` to `state`, returning a new trie that shares every untouched
 * subtree with the input. `path` uses "/" separators.
 */
export const trieSet = (trie: StateTrie, path: string, state: RecoveryState): StateTrie => {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return trie;
  const existing = trieGet(trie, path);
  if (existing && stateIdentity(existing) === stateIdentity(state)) return trie;
  const nodes = { ...trie.nodes };
  const set = (dirHash: string, depth: number): string => {
    const dir = lookupNode(nodes, dirHash);
    const name = segments[depth]!;
    const child = dir.children[name] ?? EMPTY_ROOT;
    nodes[EMPTY_ROOT] = nodes[EMPTY_ROOT] ?? EMPTY_NODE;
    let childHash: string;
    if (depth === segments.length - 1) {
      const childNode = child === EMPTY_ROOT && !nodes[child] ? EMPTY_NODE : lookupNode(nodes, child);
      const nextChild: StateTrieNode = { children: childNode.children, self: state };
      childHash = nodeHash(nextChild);
      nodes[childHash] = nextChild;
    } else {
      childHash = set(child, depth + 1);
    }
    const next: StateTrieNode = { children: { ...dir.children, [name]: childHash }, ...(dir.self ? { self: dir.self } : {}) };
    const nextHash = nodeHash(next);
    nodes[nextHash] = next;
    return nextHash;
  };
  return { root: set(trie.root, 0), nodes };
};

export const trieRemove = (trie: StateTrie, path: string): StateTrie => {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0 || trieGet(trie, path) === undefined) return trie;
  const nodes = { ...trie.nodes };
  const remove = (dirHash: string, depth: number): string | null => {
    const dir = lookupNode(nodes, dirHash);
    const name = segments[depth]!;
    const child = dir.children[name];
    if (!child) return dirHash;
    let children: Record<string, string>;
    if (depth === segments.length - 1) {
      const childNode = lookupNode(nodes, child);
      if (childNode.self === undefined) return dirHash;
      if (Object.keys(childNode.children).length === 0) {
        children = { ...dir.children };
        delete children[name];
      } else {
        const nextChild: StateTrieNode = { children: childNode.children };
        const nextChildHash = nodeHash(nextChild);
        nodes[nextChildHash] = nextChild;
        children = { ...dir.children, [name]: nextChildHash };
      }
    } else {
      const childHash = remove(child, depth + 1);
      if (childHash === child) return dirHash;
      children = { ...dir.children };
      if (childHash === null) delete children[name];
      else children[name] = childHash;
    }
    if (Object.keys(children).length === 0 && dir.self === undefined && depth > 0) return null;
    const next: StateTrieNode = { children, ...(dir.self ? { self: dir.self } : {}) };
    const nextHash = nodeHash(next);
    nodes[nextHash] = next;
    return nextHash;
  };
  const root = remove(trie.root, 0) ?? EMPTY_ROOT;
  nodes[EMPTY_ROOT] = nodes[EMPTY_ROOT] ?? EMPTY_NODE;
  return { root, nodes };
};

export const trieGet = (trie: StateTrie, path: string): RecoveryState | undefined => {
  const segments = path.split("/").filter(Boolean);
  let hash = trie.root;
  for (const name of segments) {
    const child = lookupNode(trie.nodes, hash).children[name];
    if (!child) return undefined;
    hash = child;
  }
  return lookupNode(trie.nodes, hash).self;
};

export const trieEntries = (trie: StateTrie): Array<[string, RecoveryState]> => {
  const result: Array<[string, RecoveryState]> = [];
  const walk = (hash: string, prefix: string): void => {
    const node = lookupNode(trie.nodes, hash);
    if (node.self) result.push([prefix, node.self]);
    for (const name of Object.keys(node.children).sort()) {
      walk(node.children[name]!, prefix ? `${prefix}/${name}` : name);
    }
  };
  walk(trie.root, "");
  return result;
};

export const trieToRecord = (trie: StateTrie): Record<string, RecoveryState> =>
  Object.fromEntries(trieEntries(trie));

export const trieFromEntries = (entries: Iterable<readonly [string, RecoveryState]>): StateTrie => {
  let trie = EMPTY_STATE_TRIE;
  for (const [path, state] of entries) trie = trieSet(trie, path, state);
  return trie;
};

export const trieFromRecord = (states: Record<string, RecoveryState>): StateTrie =>
  trieFromEntries(Object.entries(states));

/** Content identity of the whole map — the Merkle root. */
export const trieIdentity = (trie: StateTrie): string => `sha256-${trie.root}`;

export interface StateTrieDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Paths that differ between two tries. Identical subtree hashes are skipped
 * without descending — structure sharing makes diffs proportional to change.
 */
export const trieDiff = (before: StateTrie, after: StateTrie): StateTrieDiff => {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const collect = (hash: string, prefix: string, sink: string[]): void => {
    const node = before.nodes[hash] ?? after.nodes[hash];
    if (!node) throw new Error("State trie node is missing");
    if (node.self) sink.push(prefix);
    for (const name of Object.keys(node.children).sort()) {
      collect(node.children[name]!, prefix ? `${prefix}/${name}` : name, sink);
    }
  };
  const visit = (leftHash: string, rightHash: string, prefix: string): void => {
    if (leftHash === rightHash) return;
    if (!leftHash) {
      collect(rightHash, prefix, added);
      return;
    }
    if (!rightHash) {
      collect(leftHash, prefix, removed);
      return;
    }
    const left = lookupNode(before.nodes, leftHash);
    const right = lookupNode(after.nodes, rightHash);
    // A `missing` tombstone is a recorded map entry, distinct from no entry.
    if (left.self !== undefined && right.self !== undefined) {
      if (stateIdentity(left.self) !== stateIdentity(right.self)) changed.push(prefix);
    } else if (left.self !== undefined) {
      removed.push(prefix);
    } else if (right.self !== undefined) {
      added.push(prefix);
    }
    const names = new Set([...Object.keys(left.children), ...Object.keys(right.children)]);
    for (const name of [...names].sort()) {
      visit(left.children[name] ?? "", right.children[name] ?? "", prefix ? `${prefix}/${name}` : name);
    }
  };
  visit(before.root, after.root, "");
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
};
