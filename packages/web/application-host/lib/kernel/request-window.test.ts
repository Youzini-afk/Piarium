import { describe, expect, it } from "vitest";
import { KernelRequestWindow } from "./request-window.js";

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe("kernel transport credits", () => {
  it("keeps a cancelled native request's credit until its real acknowledgement", async () => {
    const window = new KernelRequestWindow(2);
    const controller = new AbortController();
    const first = await window.acquire(controller.signal);
    const second = await window.acquire();
    let nextAdmitted = false;
    const next = window.acquire().then(release => { nextAdmitted = true; return release; });
    controller.abort();
    await tick();
    expect(nextAdmitted).toBe(false);
    first();
    const third = await next;
    expect(nextAdmitted).toBe(true);
    first(); // Duplicate acknowledgement must not enlarge the window.
    let fourthAdmitted = false;
    const fourth = window.acquire().then(release => { fourthAdmitted = true; return release; });
    await tick();
    expect(fourthAdmitted).toBe(false);
    second();
    (await fourth)();
    third();
    await window.whenIdle();
  });

  it("cancels queued admission without encoding or consuming a native slot", async () => {
    const window = new KernelRequestWindow(1);
    const first = await window.acquire();
    const controller = new AbortController();
    const cancelled = window.acquire(controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    const next = window.acquire();
    first();
    (await next)();
    await window.whenIdle();
  });

  it("disconnect rejects all waiters while admitted work remains tracked until release", async () => {
    const window = new KernelRequestWindow(1);
    const first = await window.acquire();
    const pending = window.acquire();
    const rejected = expect(pending).rejects.toThrow("disconnected");
    window.close(new Error("disconnected"));
    await rejected;
    await expect(window.acquire()).rejects.toThrow("disconnected");
    let idle = false;
    const done = window.whenIdle().then(() => { idle = true; });
    await tick();
    expect(idle).toBe(false);
    first();
    await done;
    expect(idle).toBe(true);
  });
});
