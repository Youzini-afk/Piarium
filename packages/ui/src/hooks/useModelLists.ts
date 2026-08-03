import React from 'react';
import { usePiProviderStore, type PiProviderView } from '@/stores/usePiProviderStore';
import { useUIStore } from '@/stores/useUIStore';
import { toModelPickerModel } from '@/lib/piModelPicker';
import type { ModelPickerEntry } from '@/components/model-picker/ModelPickerList';

export interface ModelListItem {
  provider: PiProviderView;
  model: ModelPickerEntry['model'];
  providerID: string;
  modelID: string;
}

export const useModelLists = () => {
  const providers = usePiProviderStore((state) => state.providers);
  const favoriteModels = useUIStore((state) => state.favoriteModels);
  const recentModels = useUIStore((state) => state.recentModels);
  const hiddenModels = useUIStore((state) => state.hiddenModels);

  const isHidden = React.useCallback((providerID: string, modelID: string) => {
    return hiddenModels.some((item) => item.providerID === providerID && item.modelID === modelID);
  }, [hiddenModels]);

  const favoriteModelsList = React.useMemo(() => {
    return favoriteModels
      .map(({ providerID, modelID }) => {
        const provider = providers.find((p) => p.id === providerID);
        if (!provider) return null;
        const providerModels = Array.isArray(provider.models) ? provider.models : [];
        const model = providerModels.find((candidate) => candidate.id === modelID);
        if (!model) return null;
        if (isHidden(providerID, modelID)) return null;
        return { provider, model: toModelPickerModel(model), providerID, modelID };
      })
      .filter((item): item is ModelListItem => item !== null);
  }, [favoriteModels, providers, isHidden]);

  const recentModelsList = React.useMemo(() => {
    return recentModels
      .map(({ providerID, modelID }) => {
        const provider = providers.find((p) => p.id === providerID);
        if (!provider) return null;
        const providerModels = Array.isArray(provider.models) ? provider.models : [];
        const model = providerModels.find((candidate) => candidate.id === modelID);
        if (!model) return null;
        if (isHidden(providerID, modelID)) return null;
        return { provider, model: toModelPickerModel(model), providerID, modelID };
      })
      .filter((item): item is ModelListItem => item !== null)
      .filter(({ providerID, modelID }) =>
        !favoriteModels.some(fav => fav.providerID === providerID && fav.modelID === modelID)
      );
  }, [recentModels, providers, favoriteModels, isHidden]);

  return { favoriteModelsList, recentModelsList };
};
