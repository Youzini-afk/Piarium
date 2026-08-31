import type {
  PiariumApplicationSurface,
  PiariumExtensionCatalogEntry,
  PiariumWorkbenchResolvedLayout,
} from '@piarium/extension-contract';
import {
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS,
  parsePiariumWorkbenchShellContributionData,
  resolvePiariumWorkbenchShellSurfaceSeams,
  type PiariumWorkbenchShellContributionDataV1,
  type PiariumWorkbenchShellSurfaceSeams,
} from '@piarium/extension-contract';
import type { SurfaceContribution } from '@piarium/extension-surface';

export type WorkbenchSeamProjection =
  | { status: 'supported'; target: string; selected: string; candidates: SurfaceContribution[] }
  | { status: 'dormant'; target: string; selected: string }
  | { status: 'missing-selection'; target: string; selected: string; candidates: SurfaceContribution[] }
  | { status: 'platform'; target: string; selected: string; candidates: SurfaceContribution[] };

export interface WorkbenchSeamProjectionInput {
  layout: PiariumWorkbenchResolvedLayout;
  shellContributionId?: string;
  shellExtensionId?: string;
  shellStatus: 'builtin' | 'disabled' | 'failed' | 'missing' | 'ready';
  catalog: readonly PiariumExtensionCatalogEntry[];
  surface: PiariumApplicationSurface;
  visibleContributions: readonly SurfaceContribution[];
}

const PLATFORM_TARGETS = new Set<string>([
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell,
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.transition,
]);

interface ResolvedShell {
  data: PiariumWorkbenchShellContributionDataV1 | null;
  contractFailed: boolean;
}

const resolveShellData = (
  shellContributionId: string | undefined,
  shellExtensionId: string | undefined,
  shellStatus: 'builtin' | 'disabled' | 'failed' | 'missing' | 'ready',
  catalog: readonly PiariumExtensionCatalogEntry[],
  surface: PiariumApplicationSurface,
): ResolvedShell => {
  if (!shellContributionId || shellStatus === 'missing') return { data: null, contractFailed: false };
  const entry = catalog.find((candidate) => candidate.manifest.id === shellExtensionId);
  if (!entry) return { data: null, contractFailed: false };
  const contribution = entry.manifest.contributions?.find((item) => item.id === shellContributionId);
  if (!contribution) return { data: null, contractFailed: false };
  if (!contribution.supports.includes(surface)) return { data: null, contractFailed: false };
  try {
    const data = parsePiariumWorkbenchShellContributionData(contribution.data, contribution.supports);
    return { data, contractFailed: false };
  } catch {
    return { data: null, contractFailed: true };
  }
};

/**
 * Project the workbench replacement targets for the settings page.
 *
 * Rules:
 * - `workbench.shell` and `workbench.transition` are always `platform`.
 * - Targets declared in the active shell's seam for the current surface are
 *   `supported` (with candidates) or `missing-selection` (if the selected
 *   contribution is not among visible candidates).
 * - Targets with an existing selection but not declared in the current shell
 *   are `dormant` — the selection is preserved but not active.
 * - If the shell contract is malformed, no targets are `supported`.
 * - The input layout object is not mutated.
 */
export const projectWorkbenchSeams = (input: WorkbenchSeamProjectionInput): WorkbenchSeamProjection[] => {
  const { layout, shellContributionId, shellExtensionId, shellStatus, catalog, surface, visibleContributions } = input;
  const resolved = resolveShellData(shellContributionId, shellExtensionId, shellStatus, catalog, surface);
  const seams: PiariumWorkbenchShellSurfaceSeams | null = resolved.data
    ? resolvePiariumWorkbenchShellSurfaceSeams(resolved.data, surface)
    : null;
  const supportedTargets = new Set(seams?.replacementTargets ?? []);
  const candidatesByTarget = new Map<string, SurfaceContribution[]>();
  for (const contribution of visibleContributions) {
    const target = contribution.descriptor.replacement?.target;
    if (!target) continue;
    const current = candidatesByTarget.get(target) ?? [];
    candidatesByTarget.set(target, [...current, contribution]);
  }
  const allTargets = new Set<string>([
    ...PLATFORM_TARGETS,
    ...supportedTargets,
    ...Object.keys(layout.replacementSelections),
  ]);
  const projections: WorkbenchSeamProjection[] = [];
  for (const target of allTargets) {
    const selected = layout.replacementSelections[target] ?? '__builtin__';
    const candidates = candidatesByTarget.get(target) ?? [];
    if (PLATFORM_TARGETS.has(target)) {
      projections.push({ status: 'platform', target, selected, candidates });
      continue;
    }
    if (resolved.contractFailed) {
      // Shell contract is malformed — don't show any target as supported.
      // Existing selections are dormant, everything else is skipped.
      if (selected !== '__builtin__') {
        projections.push({ status: 'dormant', target, selected });
      }
      continue;
    }
    if (supportedTargets.has(target)) {
      const selectedMissing = selected !== '__builtin__'
        && !candidates.some((candidate) => candidate.descriptor.id === selected);
      if (selectedMissing) {
        projections.push({ status: 'missing-selection', target, selected, candidates });
      } else {
        projections.push({ status: 'supported', target, selected, candidates });
      }
      continue;
    }
    // Not supported by current shell
    if (selected !== '__builtin__') {
      projections.push({ status: 'dormant', target, selected });
    }
  }
  return projections.sort((a, b) => a.target.localeCompare(b.target));
};
