import { describe, expect, it, vi } from "vitest";
import { createManagedRemoteTargetRegistry } from "./managed-remote-client.js";

describe("managed remote target recovery", () => {
  it("remembers a workspace binding before the first successful target probe", async () => {
    let reachable = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain("/identity");
      if (!reachable) throw new Error("target offline");
      return new Response(JSON.stringify({
        protocolVersion: 1,
        hostId: "remote-host",
        capabilities: ["managed-execution"],
        machine: { machineId: "managed:remote-host", kind: "managed-remote", state: "available" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-varin-managed-host": "remote-host" },
      });
    });
    const reconciled: Array<{ workspaceId: string; machineId: string }> = [];
    const registry = createManagedRemoteTargetRegistry({
      coordinatorHostId: "coordinator",
      kernel: {} as never,
      resources: {
        listMachines: async () => [],
        registerMachine: async () => ({}),
      } as never,
      readSettings: async () => ({
        desktopHosts: [{ id: "remote", apiUrl: "https://remote.example", label: "Remote" }],
      }),
      fetch: fetchMock as typeof fetch,
      onTargetReachable: (workspaceId, machineId) => reconciled.push({ workspaceId, machineId }),
    });
    const machine = {
      payloadJson: JSON.stringify({ backend: "managed-remote" }),
    } as never;
    const caller = {
      workspaceId: "workspace-a",
      executionWorkspaceId: "workspace-a",
      sessionId: "session-a",
      rootSessionId: "session-a",
      allowedThreadIds: [],
    };

    await expect(registry.resolveBackend({} as never, "managed:remote-host", machine, caller)).resolves.toBeNull();
    reachable = true;
    await registry.refresh("workspace-a");

    expect(reconciled).toEqual([{ workspaceId: "workspace-a", machineId: "managed:remote-host" }]);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/jobs/submit"))).toBe(false);
  });
});
