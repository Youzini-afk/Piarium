import { describe, expect, it } from "vitest";
import { createObservationCursorStore } from "./observation-cursors.js";

describe("observation cursor store", () => {
  it("isolates observers and object kinds and snapshots cursor values", () => {
    let now = 10;
    const store = createObservationCursorStore({ now: () => now });
    const value = { offset: 4 };
    expect(store.set("observer-1", "shell", "same-id", value)).toEqual({ observedAt: 10, value: { offset: 4 } });
    value.offset = 99;
    now = 20;
    store.set("observer-1", "diagnostics", "same-id", { diagnostics: ["a"] });

    expect(store.get<{ offset: number }>("observer-1", "shell", "same-id")).toEqual({ observedAt: 10, value: { offset: 4 } });
    expect(store.get("observer-2", "shell", "same-id")).toBeNull();
    expect(store.get("observer-1", "diagnostics", "same-id")).toEqual({ observedAt: 20, value: { diagnostics: ["a"] } });
    store.clearKind("observer-1", "shell");
    expect(store.get("observer-1", "shell", "same-id")).toBeNull();
    expect(store.get("observer-1", "diagnostics", "same-id")).not.toBeNull();
    store.dispose();
  });

  it("clears one observer without disturbing unrelated cursors", () => {
    const store = createObservationCursorStore();
    store.set("observer-1", "shell", "sh_1", { offset: 1 });
    store.set("observer-1", "shell", "sh_2", { offset: 2 });
    store.set("observer-2", "shell", "sh_1", { offset: 3 });
    store.clearObserver("observer-1");
    expect(store.get("observer-1", "shell", "sh_1")).toBeNull();
    expect(store.get("observer-1", "shell", "sh_2")).toBeNull();
    expect(store.get("observer-2", "shell", "sh_1")).not.toBeNull();
    store.dispose();
  });

  it("serializes one observed object and does not restore a cursor cleared in flight", async () => {
    const store = createObservationCursorStore();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const seen: Array<number | null> = [];
    const first = store.observe<{ offset: number }, string>("observer", "shell", "sh_1", async (previous) => {
      seen.push(previous?.value.offset ?? null);
      await gate;
      return { cursor: { offset: 5 }, result: "first" };
    });
    const second = store.observe<{ offset: number }, string>("observer", "shell", "sh_1", async (previous) => {
      seen.push(previous?.value.offset ?? null);
      return { cursor: { offset: 9 }, result: "second" };
    });
    await Promise.resolve();
    store.clearObserver("observer");
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(seen).toEqual([null, null]);
    expect(store.get("observer", "shell", "sh_1")).toBeNull();
    store.dispose();
  });

  it("lets a later concurrent observation build on the cursor committed before it", async () => {
    const store = createObservationCursorStore();
    const seen: Array<number | null> = [];
    const first = store.observe<{ offset: number }, void>("observer", "shell", "sh_1", async (previous) => {
      seen.push(previous?.value.offset ?? null);
      return { cursor: { offset: 5 }, result: undefined };
    });
    const second = store.observe<{ offset: number }, void>("observer", "shell", "sh_1", async (previous) => {
      seen.push(previous?.value.offset ?? null);
      return { cursor: { offset: 9 }, result: undefined };
    });
    await Promise.all([first, second]);
    expect(seen).toEqual([null, 5]);
    expect(store.get("observer", "shell", "sh_1")).toMatchObject({ value: { offset: 9 } });
    store.dispose();
  });
});
