import type { ModelDescriptor } from '@piarium/protocol';
import type { ModelPickerEntry, ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import type { PiProviderView } from '@/stores/usePiProviderStore';

export const toModelPickerModel = (model: ModelDescriptor): ModelPickerEntry['model'] => ({
  capabilities: {
    attachment: model.input.includes('image'),
    reasoning: model.supportedThinkingLevels.some((level) => level !== 'off'),
    toolcall: true,
  },
  cost: model.cost,
  id: model.id,
  input: model.input,
  limit: { context: model.contextWindow, output: model.maxTokens },
  name: model.name,
  provider: model.provider,
  variants: Object.fromEntries(model.supportedThinkingLevels.map((level) => [level, {}])),
});

export const toModelPickerProvider = (provider: PiProviderView): ModelPickerProvider => ({
  id: provider.id,
  name: provider.name,
  models: provider.models.filter((model) => model.available).map(toModelPickerModel),
});
