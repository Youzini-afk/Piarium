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
  trieRemove,
  trieSet,
  trieToRecord,
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
