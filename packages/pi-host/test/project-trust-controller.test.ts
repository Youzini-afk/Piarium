import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { ProjectTrustController } from "../src/project-trust-controller.js";

describe("ProjectTrustController", () => {
  it("does not turn an unanswered trust prompt into a denial by default", async () => {
    let requestId: string | undefined;
    const controller = new ProjectTrustController(
      <E extends HostEvent>(event: E, data: HostEventData<E>) => {
        if (event === "project.trust.request") {
          requestId = (data as HostEventData<"project.trust.request">).id;
        }
      },
    );
    const decision = controller.request("C:/workspace");
    const state = await Promise.race([
      decision.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);

    assert.equal(state, "pending");
    assert.ok(requestId);
    assert.equal(
      controller.respond({ remember: true, requestId, trusted: true }),
      true,
    );
    assert.deepEqual(await decision, { remember: true, trusted: true });
  });

  it("supports an explicit trust prompt deadline", async () => {
    const controller = new ProjectTrustController(() => undefined);
    assert.deepEqual(await controller.request("C:/workspace", 10), {
      remember: false,
      trusted: false,
    });
  });
});
