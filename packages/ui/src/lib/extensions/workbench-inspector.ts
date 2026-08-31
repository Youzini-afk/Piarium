import type {
  PiariumApplicationSurface,
  PiariumExtensionCatalogEntry,
  PiariumExtensionStaticContribution,
  PiariumWorkbenchShellContributionDataV1,
  PiariumWorkbenchShellSurfaceSeams,
} from '@piarium/extension-contract';
import {
  PIARIUM_DEBUG_SERVICE_ID,
  PIARIUM_LANGUAGE_SERVICE_ID,
  PIARIUM_TASKS_SERVICE_ID,
  PIARIUM_TEST_SERVICE_ID,
  parsePiariumWorkbenchShellContributionData,
  resolvePiariumWorkbenchShellSurfaceSeams,
} from '@piarium/extension-contract';

type WorkbenchInspectorContribution = {
  generation?: number;
  id: string;
  kind: string;
  live: boolean;
  placement?: string;
  replacement?: string;
};

export const describeWorkbenchContributionPlacement = (
  contribution: Pick<PiariumExtensionStaticContribution, 'id' | 'kind' | 'placement' | 'replacement'>,
): Pick<WorkbenchInspectorContribution, 'id' | 'kind' | 'placement' | 'replacement'> => {
  const next: Pick<WorkbenchInspectorContribution, 'id' | 'kind' | 'placement' | 'replacement'> = {
    id: contribution.id,
    kind: contribution.kind,
  };
  if (contribution.placement?.slot) next.placement = contribution.placement.slot;
  if (contribution.replacement?.target) next.replacement = contribution.replacement.target;
  return next;
};

export type WorkbenchInspectorShellSeamSummary = {
  shellContributionId: string;
  shellExtensionId: string;
  surface: PiariumApplicationSurface;
  contractVersion: number | null;
  declaredReplacementTargets: readonly string[];
  declaredSlots: readonly string[];
  contractValid: boolean;
};

/**
 * Summarize the active shell's declared seams for a given surface.
 * Returns `null` when the shell is missing, not found in the catalog,
 * or does not support the requested surface.
 */
export const describeWorkbenchShellSeams = (
  shellContributionId: string | undefined,
  shellExtensionId: string | undefined,
  catalog: readonly PiariumExtensionCatalogEntry[],
  surface: PiariumApplicationSurface,
): WorkbenchInspectorShellSeamSummary | null => {
  if (!shellContributionId || !shellExtensionId) return null;
  const entry = catalog.find((candidate) => candidate.manifest.id === shellExtensionId);
  if (!entry) return null;
  const contribution = entry.manifest.contributions?.find((item) => item.id === shellContributionId);
  if (!contribution) return null;
  if (!contribution.supports.includes(surface)) return null;
  let data: PiariumWorkbenchShellContributionDataV1 | null = null;
  let contractValid = true;
  try {
    data = parsePiariumWorkbenchShellContributionData(contribution.data, contribution.supports);
  } catch {
    contractValid = false;
  }
  let seams: PiariumWorkbenchShellSurfaceSeams | null = null;
  if (data) {
    try {
      seams = resolvePiariumWorkbenchShellSurfaceSeams(data, surface);
    } catch {
      contractValid = false;
    }
  }
  return {
    shellContributionId,
    shellExtensionId,
    surface,
    contractVersion: contribution.contractVersion ?? null,
    declaredReplacementTargets: seams?.replacementTargets ?? [],
    declaredSlots: seams?.slots ?? [],
    contractValid,
  };
};

export const workbenchInspectorOwnsLanguage = (serviceId: string): boolean => (
  serviceId === PIARIUM_LANGUAGE_SERVICE_ID
);

export const workbenchInspectorOwnsRun = (serviceId: string): boolean => (
  serviceId === PIARIUM_DEBUG_SERVICE_ID
  || serviceId === PIARIUM_TEST_SERVICE_ID
  || serviceId === PIARIUM_TASKS_SERVICE_ID
);

export const workbenchInspectorOwnsDocuments = (capability: string): boolean => (
  capability === 'workspace.documents'
);

export const workbenchInspectorOwnsDebugCapability = (capability: string): boolean => (
  capability === 'workspace.debug'
);

export const workbenchInspectorOwnsTestCapability = (capability: string): boolean => (
  capability === 'workspace.test'
);
