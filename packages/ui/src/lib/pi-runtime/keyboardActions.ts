import {
  type ModelDescriptor,
  type SessionSnapshot,
  type ThinkingLevel,
} from '@piarium/protocol';

export interface FavoriteModelReference {
  modelID: string;
  providerID: string;
}

export const nextPiThinkingLevel = (
  snapshot: SessionSnapshot | undefined,
): ThinkingLevel | null => {
  if (!snapshot) return null;
  const levels = snapshot?.model?.supportedThinkingLevels ?? [];
  if (levels.length < 2) return null;
  const currentIndex = levels.indexOf(snapshot.thinkingLevel);
  return levels[currentIndex === -1 ? 0 : (currentIndex + 1) % levels.length] ?? null;
};

export const nextPiFavoriteModel = (
  favorites: FavoriteModelReference[],
  models: ModelDescriptor[],
  current: Pick<ModelDescriptor, 'id' | 'provider'> | undefined,
  direction: -1 | 1,
): ModelDescriptor | null => {
  const byKey = new Map(
    models
      .filter((model) => model.available)
      .map((model) => [`${model.provider}\n${model.id}`, model] as const),
  );
  const available = favorites
    .map((favorite) => byKey.get(`${favorite.providerID}\n${favorite.modelID}`))
    .filter((model): model is ModelDescriptor => model !== undefined);
  if (available.length === 0) return null;
  const currentIndex = current
    ? available.findIndex((model) => model.provider === current.provider && model.id === current.id)
    : -1;
  const baseIndex = currentIndex === -1 ? (direction > 0 ? -1 : 0) : currentIndex;
  const nextIndex = ((baseIndex + direction) % available.length + available.length) % available.length;
  return available[nextIndex] ?? null;
};
