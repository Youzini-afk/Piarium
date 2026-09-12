import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openRecoveryJournalCatalog } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/journal-files.js";
import { WorkingStateStore } from "./working-state-store.js";
import {
  EMPTY_STATE_TRIE,
  trieDiff,
  trieEntries,
  trieFromRecord,
  trieGet,
  trieIdentity,
  trieRemove,
  trieSet,
  trieToRecord,
  verifyTrie,
  type StateTrieNode,
} from "./state-trie.js";
import type { RecoveryState } from "./types.js";

const file = (text: string): RecoveryState => ({
  kind: "regular-file",
  objectHash: `sha256-${createHash("sha256").update(text).digest("hex")}`,
  byteLength: text.length,
  mode: 0o644,
});

describe("state trie", () => {
  it("round-trips a record including a path that is both entry and parent", () => {
    const states: Record<string, RecoveryState> = {
      "a": file("file-a"),
      "a/b.txt": file("nested"),
      "a/c/deep.txt": file("deep"),
      "gone.txt": { kind: "missing" },
    };
    const trie = trieFromRecord(states);
    expect(trieToRecord(trie)).toEqual(states);
    expect(trieGet(trie, "a")).toEqual(states["a"]);
    expect(trieGet(trie, "a/b.txt")).toEqual(states["a/b.txt"]);
    expect(trieGet(trie, "absent")).toBeUndefined();
  });

  it("shares unchanged subtrees between versions", () => {
    const base = trieFromRecord({
      "src/keep/a.txt": file("a"),
      "src/keep/b.txt": file("b"),
      "docs/readme.md": file("r"),
    });
    const next = trieSet(base, "src/keep/a.txt", file("a2"));
    const diff = trieDiff(base, next);
    expect(diff).toEqual({ added: [], removed: [], changed: ["src/keep/a.txt"] });
    // The docs/ subtree hash is untouched and shared by both tries.
    const docsHash = (t: typeof base) => t.nodes[t.root]?.children["docs"];
    expect(docsHash(base)).toBe(docsHash(next));
  });

  it("removes entries and prunes empty ancestors", () => {
    const base = trieFromRecord({ "x/y/z.txt": file("z"), "keep.txt": file("k") });
    const removed = trieRemove(base, "x/y/z.txt");
    expect(trieGet(removed, "x/y/z.txt")).toBeUndefined();
    expect(trieGet(removed, "keep.txt")).toEqual(file("k"));
    expect(trieEntries(removed).map(([p]) => p)).toEqual(["keep.txt"]);
  });

  it("diffs added, removed, changed and tombstone-vs-absent entries", () => {
    const before = trieFromRecord({ "a.txt": file("a"), "b.txt": file("b"), "c.txt": { kind: "missing" } });
    const after = trieFromRecord({ "a.txt": file("a"), "b.txt": file("b2"), "d.txt": file("d") });
    const diff = trieDiff(before, after);
    expect(diff).toEqual({ added: ["d.txt"], removed: ["c.txt"], changed: ["b.txt"] });
    expect(trieDiff(before, before)).toEqual({ added: [], removed: [], changed: [] });
    expect(trieDiff(EMPTY_STATE_TRIE, after).added).toEqual(["a.txt", "b.txt", "d.txt"]);
  });
});

describe("D-251 rework: platform-agnostic persistent identity", () => {
  it("0644 and 0755 at the same path produce different roots on every platform", () => {
    const content = "same\n";
    const state644: RecoveryState = { kind: "regular-file", objectHash: `sha256-${createHash("sha256").update(content).digest("hex")}`, byteLength: content.length, mode: 0o644 };
    const state755: RecoveryState = { kind: "regular-file", objectHash: `sha256-${createHash("sha256").update(content).digest("hex")}`, byteLength: content.length, mode: 0o755 };
    const trie644 = trieFromRecord({ "a.txt": state644 });
    const trie755 = trieFromRecord({ "a.txt": state755 });
    // Roots differ even on Windows where sameState would consider them equal.
    expect(trie644.root).not.toBe(trie755.root);
    expect(trieIdentity(trie644)).not.toBe(trieIdentity(trie755));
  });
});

describe("D-251 rework: node integrity verification", () => {
  it("detects a tampered node (content doesn't match hash)", () => {
    const trie = trieFromRecord({ "a.txt": file("a"), "b.txt": file("b") });
    // Tamper: replace a node's content but keep its old key.
    const root = trie.root;
    const rootNode = trie.nodes[root]!;
    const childName = Object.keys(rootNode.children)[0]!;
    const childHash = rootNode.children[childName]!;
    const childNode = trie.nodes[childHash]!;
    // Tamper the child node's self state.
    const tamperedNodes: Record<string, StateTrieNode> = { ...trie.nodes, [childHash]: { ...childNode, self: file("tampered") } };
    const tamperedTrie = { root, nodes: tamperedNodes };
    expect(() => verifyTrie(tamperedTrie)).toThrow(/corrupt/);
  });

  it("detects a missing node", () => {
    const trie = trieFromRecord({ "a.txt": file("a") });
    const root = trie.root;
    const rootNode = trie.nodes[root]!;
    const childHash = rootNode.children["a.txt"]!;
    // Remove the child node but keep the reference.
    const { [childHash]: _removed, ...remainingNodes } = trie.nodes;
    const brokenTrie = { root, nodes: remainingNodes as Record<string, StateTrieNode> };
    expect(() => verifyTrie(brokenTrie)).toThrow(/missing/);
  });

  it("detects a self-referencing child (hash mismatch catches the cycle attempt)", () => {
    const trie = trieFromRecord({ "a.txt": file("a") });
    const root = trie.root;
    const rootNode = trie.nodes[root]!;
    const childHash = rootNode.children["a.txt"]!;
    const childNode = trie.nodes[childHash]!;
    // Attempt to create a cycle by pointing the child back to the root.
    // The hash check catches this first — the node's content no longer
    // matches its key because the children changed.
    const cyclicNodes: Record<string, StateTrieNode> = {
      ...trie.nodes,
      [childHash]: { children: { "loop": root }, ...(childNode.self ? { self: childNode.self } : {}) },
    };
    const cyclicTrie = { root, nodes: cyclicNodes };
    expect(() => verifyTrie(cyclicTrie)).toThrow(/corrupt/);
  });

  it("passes verification on a valid trie", () => {
    const trie = trieFromRecord({ "a.txt": file("a"), "b/c.txt": file("c") });
    expect(() => verifyTrie(trie)).not.toThrow();
  });
});

describe("D-251 rework: structural sharing", () => {
  it("sibling branches share an unchanged subtree; writing one doesn't change the other", () => {
    const base = trieFromRecord({
      "src/shared/a.txt": file("a"),
      "src/shared/b.txt": file("b"),
      "docs/readme.md": file("r"),
    });
    const branchA = trieSet(base, "src/shared/a.txt", file("a2"));
    const branchB = trieSet(base, "docs/readme.md", file("r2"));
    // branchA's change doesn't affect branchB.
    expect(trieGet(branchB, "src/shared/a.txt")).toEqual(file("a"));
    expect(trieGet(branchA, "docs/readme.md")).toEqual(file("r"));
    // The docs/ subtree is shared between base and branchA.
    const docsHashBase = base.nodes[base.root]?.children["docs"];
    const docsHashA = branchA.nodes[branchA.root]?.children["docs"];
    expect(docsHashBase).toBe(docsHashA);
    // The src/ subtree is shared between base and branchB.
    const srcHashBase = base.nodes[base.root]?.children["src"];
    const srcHashB = branchB.nodes[branchB.root]?.children["src"];
    expect(srcHashBase).toBe(srcHashB);
  });
});

describe("D-251 rework: single-path update scales with depth, not pool size", () => {
  it("trieSet creates O(depth) new nodes, not O(pool size)", () => {
    // Build a large trie, then set a single deep path.
    // Count new nodes by comparing own properties of the new nodes object
    // (the prototype chain pattern means new nodes are own properties,
    // inherited nodes are not counted by Object.keys).
    const entries: Record<string, RecoveryState> = {};
    for (let i = 0; i < 1000; i++) {
      entries[`dir${i % 10}/sub${i % 5}/file${i}.txt`] = file(`content${i}`);
    }
    const base = trieFromRecord(entries);

    // Set a single new deep path.
    const updated = trieSet(base, "dir0/sub0/file1000.txt", file("new"));
    // The new nodes object's own properties are the newly created nodes.
    // A path at depth 3 creates ~3 new nodes (leaf + 2 interior), not 1000.
    // The exact count depends on how many segments are new vs shared, but
    // it must be proportional to depth, not pool size.
    const newNodes = Object.keys(updated.nodes).filter(
      (key) => !Object.prototype.hasOwnProperty.call(base.nodes, key),
    ).length;
    expect(newNodes).toBeLessThan(10);
    expect(newNodes).toBeGreaterThan(0);
  });

  it("trieFromEntries builds in O(n·depth), not O(n²) — 500→1000→2000 scaling", () => {
    const build = (n: number): number => {
      const entries: Record<string, RecoveryState> = {};
      for (let i = 0; i < n; i++) {
        entries[`dir${i % 10}/sub${i % 5}/file${i}.txt`] = file(`c${i}`);
      }
      const start = performance.now();
      const trie = trieFromRecord(entries);
      const elapsed = performance.now() - start;
      // Verify correctness.
      expect(Object.keys(trie.nodes).length).toBeGreaterThan(0);
      return elapsed;
    };
    const t500 = build(500);
    const t1000 = build(1000);
    const t2000 = build(2000);
    // O(n·depth) should scale roughly linearly (depth is bounded by path
    // structure, not n). The old O(n²) would show ~4x from 500→1000.
    // Allow generous slack for CI jitter, but reject ~4x growth.
    const ratio = t2000 / t500;
    expect(ratio).toBeLessThan(8); // O(n·depth) with depth=3 should be ~4x; O(n²) would be ~16x
  });
});

describe("persisted Merkle map sharing", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  it("serializes path maps as trie refs into a shared node pool and reopens identically", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "piarium-trie-store-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const recoveryRoot = path.join(root, "recovery");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "a.txt"), "one\n");
    await fs.writeFile(path.join(workspace, "b.txt"), "two\n");

    const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
    if (!database) throw new Error("catalog missing");
    try {
      const context = {
        database,
        fileStore: createRecoveryFileStore(),
        identity: { authorityId: "test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: "ws" },
        resourceOperationGate: { run: async <T>(_r: readonly unknown[], op: () => Promise<T>) => op() },
        root: recoveryRoot,
      };
      const store = await WorkingStateStore.open(context);
      const base = await store.captureDirectory(workspace);
      await store.createBranch("ws", "thread-1", base);
      await fs.writeFile(path.join(workspace, "a.txt"), "changed\n");
      const published = await store.publishDirectoryResult("thread-1", workspace);

      const catalog = path.join(recoveryRoot, "working-state", `${createHash("sha256").update("ws").digest("hex")}.json`);
      const persisted = JSON.parse(await fs.readFile(catalog, "utf8")) as {
        schemaVersion: number;
        stateNodes: Record<string, unknown>;
        branches: Record<string, { baseState: { trie: string }; deltas: { trie: string } }>;
        results: Record<string, { baseStates: { trie: string }; pathStates: { trie: string } }>;
      };
      expect(persisted.schemaVersion).toBe(4);
      expect(persisted.stateNodes).toBeTruthy();
      expect(typeof persisted.branches["thread-1"]!.baseState.trie).toBe("string");
      // The published delta map and the result's pathStates are the same map:
      // one shared trie root proves the serialized form dedups it.
      expect(persisted.branches["thread-1"]!.deltas.trie)
        .toBe(persisted.results[`thread-1@${published.resultRevision}`]!.pathStates.trie);

      const reopened = await WorkingStateStore.open(context);
      expect(reopened.getBranch("thread-1")?.baseState).toEqual(base);
      const result = reopened.getResult("thread-1", published.resultRevision);
      expect(result?.pathStates["a.txt"]).toEqual(published.pathStates["a.txt"]);
    } finally {
      database.close();
    }
  });
});
