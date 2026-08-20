import type { PiariumExtensionStaticContribution } from '@piarium/extension-contract';
import { PIARIUM_LANGUAGE_SERVICE_ID } from '@piarium/extension-contract';

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

export const workbenchInspectorOwnsLanguage = (serviceId: string): boolean => (
  serviceId === PIARIUM_LANGUAGE_SERVICE_ID
);

export const workbenchInspectorOwnsDocuments = (capability: string): boolean => (
  capability === 'workspace.documents'
);
