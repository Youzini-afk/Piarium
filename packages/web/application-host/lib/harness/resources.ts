/**
 * Resource facts: machines, commitments and observed usage (7C/7D-2, D-300).
 *
 * Capacity, committed reservations and sampled usage are separate durable
 * records, each carrying its own provenance and observation time. A request is
 * not a commitment — `admit` is the only writer that can confirm one, and it
 * serializes per machine so concurrent submissions cannot both claim the same
 * remaining capacity. Unknown capacity or an unread usage dimension is never
 * treated as free.
 */
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import type {
  ExperimentResourceRequest,
  ResourceCommitmentView,
  ResourceListResult,
  ResourceMachineView,
} from "@piarium/protocol";

const MACHINE_PREFIX = "resource.machine:";
const COMMITMENT_PREFIX = "resource.commitment:";
const SAMPLE_PREFIX = "resource.sample:";
const LOCAL_MACHINE_ID = "local";
const SAMPLE_STALE_MS = 120_000;

export interface LocalMachineProbe {
  cpuCores: number;
  memoryMb: number;
  usedMemoryMb: number;
  /** 0-100 across all cores, or undefined when not measured. */
  cpuPercent?: number;
}

const defaultProbe = (): LocalMachineProbe => {
  const cores = os.cpus().length;
  const memoryMb = Math.round(os.totalmem() / (1024 * 1024));
  const usedMemoryMb = Math.round((os.totalmem() - os.freemem()) / (1024 * 1024));
  const load = os.loadavg()[0];
  const cpuPercent = load !== undefined && Number.isFinite(load) && cores > 0
    ? Math.min(100, Math.round((load / cores) * 100))
    : undefined;
  return {
    cpuCores: cores,
    memoryMb,
    usedMemoryMb,
    ...(cpuPercent === undefined ? {} : { cpuPercent }),
  };
};

export interface ResourceAdmission {
  status: "confirmed" | "insufficient";
  commitmentId?: string;
  /** Remaining capacity after confirmed commitments, when known. */
  remaining?: ExperimentResourceRequest;
  reason?: string;
}

/**
 * Registration of a non-local execution target by connection management
 * (SSH instance, remote Piarium Host, cluster). A freshly registered machine
 * is offline with unknown connection until a real probe reports otherwise —
 * registration alone never claims capacity or reachability.
 */
export interface ResourceMachineRegistration {
  /** Stable machine identity; generated when omitted. */
  machineId?: string;
  kind: string;
  label?: string;
  /** Which experiment backend reaches this machine (e.g. "piarium-host", "slurm"). */
  backend?: string;
  state?: "available" | "degraded" | "offline";
  capacity?: {
    cpuCores?: number;
    memoryMb?: number;
    gpus?: Array<{ index: number; name?: string; memoryMb?: number }>;
  };
  connection?: { status: "connected" | "degraded" | "offline" | "unknown"; detail?: string };
}

interface ResourceServiceDeps {
  client: KernelClient;
  /** Monotonic clock injection for tests. */
  now?: () => number;
  probeLocal?: () => LocalMachineProbe;
  onError?: (error: Error) => void;
}

export const resourceMachineRecordId = (machineId: string): string => `${MACHINE_PREFIX}${machineId}`;

const recordIdFor = {
  machine: (id: string) => `${MACHINE_PREFIX}${id}`,
  commitment: (id: string) => `${COMMITMENT_PREFIX}${id}`,
  sample: (machineId: string) => `${SAMPLE_PREFIX}${machineId}`,
};

const payloadOf = (record: KernelRecordResult): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(record.payloadJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const num = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isFinite(value) ? value : undefined
);

const str = (value: unknown): string | undefined => (
  typeof value === "string" && value ? value : undefined
);

const asResources = (value: unknown): ExperimentResourceRequest => {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const cpuCores = num(raw.cpuCores);
  const memoryMb = num(raw.memoryMb);
  const gpuCount = num(raw.gpuCount);
  const gpuMemoryMb = num(raw.gpuMemoryMb);
  return {
    ...(cpuCores === undefined ? {} : { cpuCores }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(gpuCount === undefined ? {} : { gpuCount }),
    ...(gpuMemoryMb === undefined ? {} : { gpuMemoryMb }),
  };
};

const gpuCapacity = (capacity: Record<string, unknown>): { count?: number; memoryMb?: number } => {
  if (!Array.isArray(capacity.gpus)) return {};
  return {
    count: capacity.gpus.length,
    memoryMb: capacity.gpus.reduce((sum, gpu) => (
      sum + (gpu && typeof gpu === "object" ? num((gpu as Record<string, unknown>).memoryMb) ?? 0 : 0)
    ), 0),
  };
};

const remainingCapacity = (
  capacity: Record<string, unknown>,
  committed: ExperimentResourceRequest[],
): ExperimentResourceRequest => {
  const remaining: ExperimentResourceRequest = {};
  const gpus = gpuCapacity(capacity);
  const totals: Record<"cpuCores" | "memoryMb" | "gpuCount" | "gpuMemoryMb", number | undefined> = {
    cpuCores: num(capacity.cpuCores),
    memoryMb: num(capacity.memoryMb),
    gpuCount: gpus.count,
    gpuMemoryMb: gpus.memoryMb,
  };
  for (const key of ["cpuCores", "memoryMb", "gpuCount", "gpuMemoryMb"] as const) {
    const total = totals[key];
    if (total === undefined) continue;
    const used = committed.reduce((sum, entry) => sum + (entry[key] ?? 0), 0);
    remaining[key] = Math.max(0, total - used);
  }
  return remaining;
};

export function createResourceService(deps: ResourceServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const probe = deps.probeLocal ?? defaultProbe;
  // Admission is serialized per machine so two submissions cannot both observe
  // the same remaining capacity before either commitment lands.
  const admissionChains = new Map<string, Promise<unknown>>();
  const contexts = new Map<string, Promise<KernelScopedClient>>();
  const report = (error: unknown) => {
    if (deps.onError) deps.onError(error instanceof Error ? error : new Error(String(error)));
  };

  const context = (workspaceId: string): Promise<KernelScopedClient> => {
    const existing = contexts.get(workspaceId);
    if (existing) return existing;
    const creating = (async () => {
      const grant = await deps.client.issueGrant({
        grantId: `resource:${randomUUID()}`,
        owningWorkspace: workspaceId,
        executionWorkspace: workspaceId,
        capabilities: ["storage.read", "storage.write", "storage.maintenance"],
        pathScopes: [""],
      });
      return deps.client.scoped(grant);
    })();
    contexts.set(workspaceId, creating);
    void creating.catch(() => { if (contexts.get(workspaceId) === creating) contexts.delete(workspaceId); });
    return creating;
  };

  const allRecords = async (
    scoped: KernelScopedClient,
    workspaceId: string,
    recordType: string,
  ): Promise<KernelRecordResult[]> => {
    const all: KernelRecordResult[] = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.listRecords({
        workspaceId, recordType, pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      all.push(...page.records);
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return all;
  };

  const putRecord = async (
    workspaceId: string,
    input: {
      recordId: string;
      recordType: string;
      state: string;
      payload: Record<string, unknown>;
      sessionId?: string;
      threadId?: string;
      runId?: string;
      expectedRecordRevision?: number;
    },
  ): Promise<KernelRecordResult> => {
    const scoped = await context(workspaceId);
    return scoped.putRecord({
      operationId: `${input.recordType}:${randomUUID()}`,
      recordId: input.recordId,
      workspaceId,
      recordType: input.recordType,
      state: input.state,
      payloadJson: JSON.stringify(input.payload),
      ownerIds: [],
      references: [],
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.expectedRecordRevision === undefined ? {} : { expectedRecordRevision: input.expectedRecordRevision }),
    });
  };

  const ensureLocalMachine = async (workspaceId: string): Promise<KernelRecordResult> => {
    const recordId = recordIdFor.machine(LOCAL_MACHINE_ID);
    const scoped = await context(workspaceId);
    const existing = await scoped.getRecord(workspaceId, recordId);
    const observed = probe();
    const capacity = { cpuCores: observed.cpuCores, memoryMb: observed.memoryMb };
    if (existing) {
      const payload = payloadOf(existing);
      const prior = payload.capacity && typeof payload.capacity === "object"
        ? payload.capacity as Record<string, unknown>
        : {};
      // Refresh capacity facts only when the probe actually observed a change.
      if (num(prior.cpuCores) === capacity.cpuCores && num(prior.memoryMb) === capacity.memoryMb) {
        return existing;
      }
      return putRecord(workspaceId, {
        recordId,
        recordType: "resource.machine",
        state: existing.state,
        expectedRecordRevision: existing.recordRevision,
        payload: {
          ...payload,
          capacity: { ...prior, ...capacity },
          connection: { status: "connected", checkedAt: now() },
        },
      });
    }
    return putRecord(workspaceId, {
      recordId,
      recordType: "resource.machine",
      state: "available",
      payload: {
        id: LOCAL_MACHINE_ID,
        kind: "local",
        label: "Local machine",
        capacity,
        connection: { status: "connected", checkedAt: now() },
      },
    });
  };

  const sampleLocalMachine = async (workspaceId: string): Promise<KernelRecordResult> => {
    const recordId = recordIdFor.sample(LOCAL_MACHINE_ID);
    const scoped = await context(workspaceId);
    const existing = await scoped.getRecord(workspaceId, recordId);
    const observed = probe();
    return putRecord(workspaceId, {
      recordId,
      recordType: "resource.sample",
      state: "observed",
      ...(existing ? { expectedRecordRevision: existing.recordRevision } : {}),
      payload: {
        machineId: LOCAL_MACHINE_ID,
        observedAt: now(),
        source: "host-os",
        usage: {
          memoryMb: observed.usedMemoryMb,
          ...(observed.cpuPercent === undefined ? {} : { cpuPercent: observed.cpuPercent }),
        },
      },
    });
  };

  const commitmentView = (record: KernelRecordResult): ResourceCommitmentView | null => {
    const payload = payloadOf(record);
    const machineId = str(payload.machineId);
    if (!machineId) return null;
    const attemptId = str(payload.attemptId);
    const confirmedAt = num(payload.confirmedAt);
    const releasedAt = num(payload.releasedAt);
    return {
      commitmentId: record.recordId.slice(COMMITMENT_PREFIX.length),
      machineId,
      ...(attemptId ? { attemptId } : {}),
      resources: asResources(payload.resources),
      state: record.state as ResourceCommitmentView["state"],
      ...(confirmedAt === undefined ? {} : { confirmedAt }),
      ...(releasedAt === undefined ? {} : { releasedAt }),
    };
  };

  const machineView = (
    record: KernelRecordResult,
    sample: KernelRecordResult | null,
    commitments: ResourceCommitmentView[],
    queued: ResourceMachineView["queued"],
  ): ResourceMachineView => {
    const payload = payloadOf(record);
    const connection = payload.connection && typeof payload.connection === "object"
      ? payload.connection as Record<string, unknown>
      : {};
    const capacity = payload.capacity && typeof payload.capacity === "object"
      ? payload.capacity as Record<string, unknown>
      : null;
    const samplePayload = sample ? payloadOf(sample) : null;
    const usage = samplePayload?.usage && typeof samplePayload.usage === "object"
      ? samplePayload.usage as Record<string, unknown>
      : null;
    const observedAt = num(samplePayload?.observedAt);
    const gpus = Array.isArray(capacity?.gpus)
      ? capacity.gpus.flatMap((gpu) => {
          if (!gpu || typeof gpu !== "object") return [];
          const entry = gpu as Record<string, unknown>;
          const index = num(entry.index);
          if (index === undefined) return [];
          const name = str(entry.name);
          const memoryMb = num(entry.memoryMb);
          return [{
            index,
            ...(name ? { name } : {}),
            ...(memoryMb === undefined ? {} : { memoryMb }),
          }];
        })
      : undefined;
    const label = str(payload.label);
    const detail = str(connection.detail);
    const cpuCapacity = num(capacity?.cpuCores);
    const memoryCapacity = num(capacity?.memoryMb);
    const usedCpuPercent = num(usage?.cpuPercent);
    const usedMemoryMb = num(usage?.memoryMb);
    return {
      machineId: record.recordId.slice(MACHINE_PREFIX.length),
      kind: str(payload.kind) ?? "unknown",
      ...(label ? { label } : {}),
      state: record.state as ResourceMachineView["state"],
      connection: {
        status: (["connected", "degraded", "offline", "unknown"] as const)
          .find((value) => value === connection.status) ?? "unknown",
        checkedAt: num(connection.checkedAt) ?? record.updatedAt,
        ...(detail ? { detail } : {}),
      },
      ...(capacity ? {
        capacity: {
          ...(cpuCapacity === undefined ? {} : { cpuCores: cpuCapacity }),
          ...(memoryCapacity === undefined ? {} : { memoryMb: memoryCapacity }),
          ...(gpus ? { gpus } : {}),
          observedAt: record.updatedAt,
        },
      } : {}),
      ...(usage && observedAt !== undefined ? {
        usage: {
          ...(usedCpuPercent === undefined ? {} : { cpuPercent: usedCpuPercent }),
          ...(usedMemoryMb === undefined ? {} : { memoryMb: usedMemoryMb }),
          observedAt,
          source: str(samplePayload?.source) ?? "unknown",
          stale: now() - observedAt > SAMPLE_STALE_MS,
        },
      } : {}),
      commitments,
      queued,
    };
  };

  const admit = async (
    workspaceId: string,
    machineId: string,
    resources: ExperimentResourceRequest,
    attemptId: string,
  ): Promise<ResourceAdmission> => {
    const key = `${workspaceId}${machineId}`;
    const run = async (): Promise<ResourceAdmission> => {
      await ensureLocalMachine(workspaceId);
      const scoped = await context(workspaceId);
      const machine = await scoped.getRecord(workspaceId, recordIdFor.machine(machineId));
      if (!machine || machine.state !== "available") {
        return { status: "insufficient", reason: `machine ${machineId} is ${machine?.state ?? "unknown"}` };
      }
      const capacity = (payloadOf(machine).capacity ?? {}) as Record<string, unknown>;
      const commitments = (await allRecords(scoped, workspaceId, "resource.commitment"))
        .filter((record) => record.state === "confirmed" || record.state === "requested")
        .map(commitmentView)
        .filter((view): view is ResourceCommitmentView => view !== null && view.machineId === machineId);
      const remaining = remainingCapacity(capacity, commitments.map((view) => view.resources));
      const gpus = gpuCapacity(capacity);
      const requested: Array<["cpuCores" | "memoryMb" | "gpuCount" | "gpuMemoryMb", number | undefined]> = [
        ["cpuCores", resources.cpuCores],
        ["memoryMb", resources.memoryMb],
        ["gpuCount", resources.gpuCount],
        ["gpuMemoryMb", resources.gpuMemoryMb],
      ];
      for (const [dimension, wanted] of requested) {
        if (wanted === undefined || wanted <= 0) continue;
        const capacityTotal = dimension === "gpuCount" ? gpus.count
          : dimension === "gpuMemoryMb" ? gpus.memoryMb
          : num(capacity[dimension]);
        if (capacityTotal === undefined) {
          return { status: "insufficient", remaining, reason: `machine ${machineId} reports no ${dimension} capacity` };
        }
        if ((remaining[dimension] ?? 0) < wanted) {
          return { status: "insufficient", remaining, reason: `insufficient ${dimension} on ${machineId}` };
        }
      }
      const commitmentId = `commit-${randomUUID()}`;
      await putRecord(workspaceId, {
        recordId: recordIdFor.commitment(commitmentId),
        recordType: "resource.commitment",
        state: "confirmed",
        payload: {
          id: commitmentId,
          machineId,
          attemptId,
          resources,
          confirmedBy: "local-admission",
          confirmedAt: now(),
        },
      });
      return { status: "confirmed", commitmentId, remaining };
    };
    const chained = (admissionChains.get(key) ?? Promise.resolve()).then(run, run);
    admissionChains.set(key, chained.catch(() => undefined));
    return chained;
  };

  const release = async (workspaceId: string, commitmentId: string, reason: string): Promise<void> => {
    const recordId = recordIdFor.commitment(commitmentId);
    const scoped = await context(workspaceId);
    const existing = await scoped.getRecord(workspaceId, recordId);
    if (!existing || (existing.state !== "confirmed" && existing.state !== "requested")) return;
    const payload = payloadOf(existing);
    await putRecord(workspaceId, {
      recordId,
      recordType: "resource.commitment",
      state: "released",
      expectedRecordRevision: existing.recordRevision,
      payload: { ...payload, releasedAt: now(), releaseReason: reason },
    });
  };

  const listMachines = async (workspaceId: string): Promise<ResourceMachineView[]> => {
    await ensureLocalMachine(workspaceId).catch(report);
    await sampleLocalMachine(workspaceId).catch(report);
    const scoped = await context(workspaceId);
    const [machines, samples, commitments, attempts] = await Promise.all([
      allRecords(scoped, workspaceId, "resource.machine"),
      allRecords(scoped, workspaceId, "resource.sample"),
      allRecords(scoped, workspaceId, "resource.commitment"),
      allRecords(scoped, workspaceId, "experiment.attempt"),
    ]);
    const sampleByMachine = new Map(samples.map((record) => [record.recordId.slice(SAMPLE_PREFIX.length), record]));
    return machines.map((machine) => {
      const machineId = machine.recordId.slice(MACHINE_PREFIX.length);
      const active = commitments
        .map(commitmentView)
        .filter((view): view is ResourceCommitmentView => (
          view !== null && view.machineId === machineId && (view.state === "confirmed" || view.state === "requested")
        ));
      return machineView(machine, sampleByMachine.get(machineId) ?? null, active, queuedAttemptsFor(attempts, machineId));
    });
  };

  // Queue facts are read from the experiment service's durable records;
  // this service presents them but never writes them.
  const queuedAttemptsFor = (
    attempts: KernelRecordResult[],
    machineId: string,
  ): ResourceMachineView["queued"] => (
    attempts
      .filter((record) => record.state === "queued")
      .flatMap((record) => {
        const payload = payloadOf(record);
        if ((str(payload.machineId) ?? LOCAL_MACHINE_ID) !== machineId) return [];
        const attemptId = str(payload.id);
        if (!attemptId) return [];
        const resources = payload.resources && typeof payload.resources === "object"
          ? asResources(payload.resources) : {};
        return [{
          attemptId,
          ...(Object.keys(resources).length ? { resources } : {}),
          ...(str(payload.queueReason) ? { reason: str(payload.queueReason) } : {}),
          queuedAt: num(payload.createdAt) ?? record.createdAt,
        }];
      })
      .sort((a, b) => a.queuedAt - b.queuedAt)
  );

  const getMachine = async (workspaceId: string, machineId: string): Promise<ResourceMachineView | null> => {
    const scoped = await context(workspaceId);
    const record = await scoped.getRecord(workspaceId, recordIdFor.machine(machineId));
    if (!record) return null;
    const [samples, commitments, attempts] = await Promise.all([
      allRecords(scoped, workspaceId, "resource.sample"),
      allRecords(scoped, workspaceId, "resource.commitment"),
      allRecords(scoped, workspaceId, "experiment.attempt"),
    ]);
    const sample = samples.find((entry) => entry.recordId === recordIdFor.sample(machineId)) ?? null;
    const active = commitments
      .map(commitmentView)
      .filter((view): view is ResourceCommitmentView => (
        view !== null && view.machineId === machineId && (view.state === "confirmed" || view.state === "requested")
      ));
    return machineView(record, sample, active, queuedAttemptsFor(attempts, machineId));
  };

  const registerMachine = async (
    workspaceId: string,
    input: ResourceMachineRegistration,
  ): Promise<ResourceMachineView> => {
    const kind = input.kind?.trim();
    if (!kind) throw new Error("machine registration requires a kind");
    const machineId = input.machineId?.trim() || `machine-${randomUUID().slice(0, 12)}`;
    if (machineId === LOCAL_MACHINE_ID) {
      throw new Error("the local machine is self-describing; it cannot be registered");
    }
    const capacity = input.capacity
      ? {
          ...(num(input.capacity.cpuCores) !== undefined ? { cpuCores: num(input.capacity.cpuCores) } : {}),
          ...(num(input.capacity.memoryMb) !== undefined ? { memoryMb: num(input.capacity.memoryMb) } : {}),
          ...(Array.isArray(input.capacity.gpus)
            ? { gpus: input.capacity.gpus.filter((gpu) => num(gpu?.index) !== undefined) }
            : {}),
        }
      : undefined;
    const scoped = await context(workspaceId);
    const recordId = recordIdFor.machine(machineId);
    const existing = await scoped.getRecord(workspaceId, recordId);
    const prior = existing ? payloadOf(existing) : {};
    const connection = input.connection
      ? { status: input.connection.status, checkedAt: now(), ...(input.connection.detail ? { detail: input.connection.detail } : {}) }
      : (prior.connection && typeof prior.connection === "object"
          ? prior.connection as Record<string, unknown>
          : { status: "unknown", checkedAt: now(), detail: "registered, never probed" });
    const state = input.state
      ?? (existing && (existing.state === "available" || existing.state === "degraded" || existing.state === "offline" || existing.state === "retired")
          ? existing.state
          : "offline");
    const record = await putRecord(workspaceId, {
      recordId,
      recordType: "resource.machine",
      state,
      ...(existing ? { expectedRecordRevision: existing.recordRevision } : {}),
      payload: {
        id: machineId,
        kind,
        ...(input.label?.trim() ? { label: input.label.trim() } : prior.label ? { label: prior.label } : {}),
        ...(input.backend?.trim()
          ? { backend: input.backend.trim() }
          : prior.backend ? { backend: prior.backend } : {}),
        ...(capacity ? { capacity } : prior.capacity ? { capacity: prior.capacity } : {}),
        connection,
      },
    });
    const view = await getMachine(workspaceId, str(payloadOf(record).id) ?? machineId);
    if (!view) throw new Error("registered machine is unreadable");
    return view;
  };

  const list = async (workspaceId: string): Promise<ResourceListResult> => {
    const machines = await listMachines(workspaceId);
    const text = machines.length === 0
      ? "No execution targets are registered."
      : machines.map((machine) => {
          const capacityParts: string[] = [];
          if (machine.capacity?.cpuCores !== undefined) capacityParts.push(`${machine.capacity.cpuCores} cpu`);
          if (machine.capacity?.memoryMb !== undefined) capacityParts.push(`${Math.round(machine.capacity.memoryMb / 1024)} GiB`);
          if (machine.capacity?.gpus?.length) capacityParts.push(`${machine.capacity.gpus.length} gpu`);
          const capacity = capacityParts.length ? capacityParts.join("/") : "capacity unknown";
          const usage = machine.usage
            ? `used ${machine.usage.memoryMb !== undefined ? `${Math.round(machine.usage.memoryMb / 1024)} GiB mem` : "mem ?"}${machine.usage.stale ? " (stale)" : ""}`
            : "usage unread";
          const committed = machine.commitments.length
            ? `${machine.commitments.length} commitment(s)`
            : "no commitments";
          const queued = machine.queued.length
            ? ` · ${machine.queued.length} queued (${machine.queued.map((entry) => entry.attemptId).join(", ")})`
            : "";
          return `${machine.machineId} · ${machine.kind} · ${machine.state} · ${machine.connection.status} · ${capacity} · ${usage} · ${committed}${queued}`;
        }).join("\n");
    return { machines, generatedAt: now(), text };
  };

  return {
    ensureLocalMachine,
    sampleLocalMachine,
    listMachines,
    getMachine,
    registerMachine,
    list,
    admit,
    release,
  };
}

export type ResourceService = ReturnType<typeof createResourceService>;
