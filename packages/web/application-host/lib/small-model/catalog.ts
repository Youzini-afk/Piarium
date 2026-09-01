// @ts-nocheck
import { getModelsMetadata } from '../platform/models-metadata.js';

// The models.dev catalog is shared with the /api/piarium/models-metadata
// route through one in-process cache 鈥?no extra fetches, no cache files.
export async function getModelCatalog() {
  const { metadata } = await getModelsMetadata();
  return metadata;
}

export function getCatalogProvider(catalog, providerID) {
  const entry = catalog?.[providerID];
  return entry && typeof entry === 'object' ? entry : null;
}
