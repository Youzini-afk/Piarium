import {
  getModelsMetadata,
  type ModelsMetadata,
} from '../platform/models-metadata.js';

// The models.dev catalog is shared with the /api/piarium/models-metadata
// route through one in-process cache — no extra fetches, no cache files.
export async function getModelCatalog(): Promise<ModelsMetadata> {
  const { metadata } = await getModelsMetadata();
  return metadata;
}

export function getCatalogProvider(catalog: ModelsMetadata | null | undefined, providerID: string): Record<string, unknown> | null {
  const entry = catalog?.[providerID];
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? entry as Record<string, unknown>
    : null;
}
