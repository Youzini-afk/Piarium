import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  allocateGpuDevices,
  parseNvidiaSmiCsv,
  type GpuDeviceFact,
} from "./gpu-resources.js";

const devices: GpuDeviceFact[] = [
  { index: 0, uuid: "GPU-aaa", name: "GPU A", memoryMb: 8_192, usedMemoryMb: 100, utilizationPercent: 3 },
  { index: 1, uuid: "GPU-bbb", name: "GPU B", memoryMb: 16_384, usedMemoryMb: 200, utilizationPercent: 7 },
];

describe("nvidia GPU facts and allocation", () => {
  it("parses stable UUID, capacity and observed usage from nvidia-smi CSV", () => {
    assert.deepEqual(parseNvidiaSmiCsv([
      "0, GPU-aaa, GPU A, 8192, 100, 3",
      "1, GPU-bbb, GPU B, 16384, 200, 7",
      "",
    ].join("\n")), devices);
  });

  it("binds a new commitment to an uncommitted UUID and emits CUDA environment", () => {
    const result = allocateGpuDevices(devices, [{ gpuCount: 1, allocation: {
      devices: [{ index: 0, uuid: "GPU-aaa", memoryMb: 8_192 }],
      environment: { name: "CUDA_VISIBLE_DEVICES", value: "GPU-aaa" },
    } }], { gpuCount: 1, gpuMemoryMb: 12_000 });
    assert.equal(result.status, "confirmed");
    if (result.status !== "confirmed") return;
    assert.deepEqual(result.allocation.devices.map((device) => device.uuid), ["GPU-bbb"]);
    assert.equal(result.allocation.environment.value, "GPU-bbb");
  });

  it("refuses to invent a binding for an active commitment without device identity", () => {
    const result = allocateGpuDevices(devices, [{ gpuCount: 1 }], { gpuCount: 1 });
    assert.equal(result.status, "insufficient");
    if (result.status === "insufficient") assert.match(result.reason, /reconciliation|allocation/i);
  });

  it("requires reconciliation when a retained UUID disappears from inventory", () => {
    const result = allocateGpuDevices(
      [devices[1]!],
      [{ gpuCount: 1, allocation: {
        devices: [{ index: 0, uuid: "GPU-aaa", memoryMb: 8_192 }],
        environment: { name: "CUDA_VISIBLE_DEVICES", value: "GPU-aaa" },
      } }],
      { gpuCount: 1 },
    );
    assert.equal(result.status, "insufficient");
    if (result.status === "insufficient") assert.match(result.reason, /missing|reconciliation/i);
  });

  it("keeps a memory-only request concrete by selecting enough real devices", () => {
    const result = allocateGpuDevices(devices, [], { gpuMemoryMb: 20_000 });
    assert.equal(result.status, "confirmed");
    if (result.status !== "confirmed") return;
    assert.deepEqual(result.allocation.devices.map((device) => device.uuid), ["GPU-aaa", "GPU-bbb"]);
  });

  it("does not count observed external GPU memory as available", () => {
    const result = allocateGpuDevices([
      { index: 0, uuid: "GPU-busy", memoryMb: 8_192, usedMemoryMb: 7_500 },
    ], [], { gpuMemoryMb: 1_000 });
    assert.equal(result.status, "insufficient");
    if (result.status === "insufficient") assert.match(result.reason, /available GPU memory/i);
  });

  it("does not treat unknown observed GPU usage as zero", () => {
    const result = allocateGpuDevices([
      { index: 0, uuid: "GPU-unknown", memoryMb: 8_192 },
    ], [], { gpuMemoryMb: 1_000 });
    assert.equal(result.status, "insufficient");
    if (result.status === "insufficient") assert.match(result.reason, /unknown/i);
  });
});
