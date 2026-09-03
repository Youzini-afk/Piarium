import { describe, expect, it } from "vitest";
import { createPathLockService } from "./path-lock.js";

describe("path lock service", () => {
  it("acquires a lock on a free path", async () => {
    const locks = createPathLockService();
    const acquired = await locks.acquire("session-1", "/workspace/file.txt");
    expect(acquired).toBe(true);
    expect(locks.release("session-1", "/workspace/file.txt")).toBe(true);
    locks.dispose();
  });

  it("queues concurrent locks on the same path", async () => {
    const locks = createPathLockService();
    const order: string[] = [];

    const p1 = locks.acquire("session-1", "/workspace/file.txt").then(() => { order.push("first"); });
    const p2 = locks.acquire("session-1", "/workspace/file.txt").then(() => { order.push("second"); });

    await p1;
    locks.release("session-1", "/workspace/file.txt");
    await p2;
    locks.release("session-1", "/workspace/file.txt");

    expect(order).toEqual(["first", "second"]);
    locks.dispose();
  });

  it("allows concurrent locks on different paths", async () => {
    const locks = createPathLockService();
    const p1 = locks.acquire("session-1", "/workspace/a.txt");
    const p2 = locks.acquire("session-1", "/workspace/b.txt");
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    locks.release("session-1", "/workspace/a.txt");
    locks.release("session-1", "/workspace/b.txt");
    locks.dispose();
  });

  it("times out when lock is not released", async () => {
    const locks = createPathLockService();
    await locks.acquire("session-1", "/workspace/file.txt");
    await expect(locks.acquire("session-1", "/workspace/file.txt", 50)).rejects.toThrow("Lock timeout");
    locks.release("session-1", "/workspace/file.txt");
    locks.dispose();
  });

  it("releases lock even on exception", async () => {
    const locks = createPathLockService();
    await locks.acquire("session-1", "/workspace/file.txt");
    let threw = false;
    try {
      throw new Error("something went wrong");
    } catch {
      threw = true;
    } finally {
      locks.release("session-1", "/workspace/file.txt");
    }
    expect(threw).toBe(true);
    // Lock should be available again
    const acquired = await locks.acquire("session-1", "/workspace/file.txt");
    expect(acquired).toBe(true);
    locks.release("session-1", "/workspace/file.txt");
    locks.dispose();
  });

  it("dropSession rejects pending waiters", async () => {
    const locks = createPathLockService();
    await locks.acquire("session-1", "/workspace/file.txt");
    const p2 = locks.acquire("session-1", "/workspace/file.txt", 10_000);
    // Drop session while p2 is waiting
    locks.dropSession("session-1");
    await expect(p2).rejects.toThrow("Session dropped");
    locks.dispose();
  });

  it("release is idempotent (returns false for unheld path)", () => {
    const locks = createPathLockService();
    expect(locks.release("session-1", "/workspace/unlocked.txt")).toBe(false);
    locks.dispose();
  });
});
