import {
  SurfaceExtensionRuntime,
  type SurfaceActivation,
  type SurfaceOwnerIdentity,
} from "@piarium/extension-surface";

export interface SurfaceConformanceResult {
  activeContributionIds: string[];
  activeServiceIds: string[];
  finalRevision: number;
}

export const runSurfaceExtensionConformance = async (options: {
  activation: SurfaceActivation;
  owner: SurfaceOwnerIdentity;
  runtime: SurfaceExtensionRuntime;
}): Promise<SurfaceConformanceResult> => {
  await options.runtime.activate({ owner: options.owner }, options.activation);
  const active = options.runtime.getSnapshot();
  const activeContributionIds = active.contributions
    .filter((item) => item.owner.extensionId === options.owner.extensionId)
    .map((item) => item.descriptor.id);
  const activeServiceIds = active.services
    .filter((item) => item.owner.extensionId === options.owner.extensionId)
    .map((item) => item.descriptor.id);
  await options.runtime.deactivate({
    ...options.owner,
    desiredRevision: options.owner.desiredRevision + 1,
    generation: options.owner.generation + 1,
  });
  const inactive = options.runtime.getSnapshot();
  if (inactive.contributions.some((item) => item.owner.extensionId === options.owner.extensionId)) {
    throw new Error("Surface extension leaked contributions after deactivation");
  }
  if (inactive.services.some((item) => item.owner.extensionId === options.owner.extensionId)) {
    throw new Error("Surface extension leaked services after deactivation");
  }
  return { activeContributionIds, activeServiceIds, finalRevision: inactive.revision };
};
