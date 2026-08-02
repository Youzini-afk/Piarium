export type ParsedMultiRunTitle = {
  groupSlug: string;
  runGroup?: string;
  providerID: string;
  modelID: string;
  index?: number;
  fusion: boolean;
};

const GROUP_SLUG_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;
const RUN_GROUP_PATTERN = /^g[1-9]\d*$/;

const decodeSegment = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const parseSuffix = (
  groupSlug: string,
  runGroup: string | undefined,
  providerID: string,
  modelID: string,
  suffix: string | undefined,
): ParsedMultiRunTitle | null => {
  const decodedGroupSlug = decodeSegment(groupSlug);
  const decodedProviderID = decodeSegment(providerID);
  const decodedModelID = decodeSegment(modelID);
  if (!decodedGroupSlug || !GROUP_SLUG_PATTERN.test(decodedGroupSlug)) return null;
  if (runGroup !== undefined && !RUN_GROUP_PATTERN.test(runGroup)) return null;
  if (!decodedProviderID?.trim() || !decodedModelID?.trim()) return null;
  if (decodedProviderID !== decodedProviderID.trim() || decodedModelID !== decodedModelID.trim()) return null;

  if (suffix === undefined) {
    return {
      groupSlug: decodedGroupSlug,
      runGroup,
      providerID: decodedProviderID,
      modelID: decodedModelID,
      fusion: false,
    };
  }

  if (suffix === 'fusion') {
    return {
      groupSlug: decodedGroupSlug,
      runGroup,
      providerID: decodedProviderID,
      modelID: decodedModelID,
      fusion: true,
    };
  }

  if (!/^\d+$/.test(suffix)) return null;
  const index = Number.parseInt(suffix, 10);
  if (!Number.isSafeInteger(index) || index <= 0) return null;

  return {
    groupSlug: decodedGroupSlug,
    runGroup,
    providerID: decodedProviderID,
    modelID: decodedModelID,
    index,
    fusion: false,
  };
};

export const parseMultiRunSessionTitle = (title?: string | null): ParsedMultiRunTitle | null => {
  if (!title) return null;
  const segments = title.split('/');
  if (segments.length < 3) return null;

  const groupSlug = segments[0];
  const second = segments[1];
  const hasEmptyLegacyRunGroup = second === '';
  const runGroup = RUN_GROUP_PATTERN.test(second) ? second : undefined;
  const providerIndex = runGroup !== undefined || hasEmptyLegacyRunGroup ? 2 : 1;
  const providerID = segments[providerIndex];
  const modelSegments = segments.slice(providerIndex + 1);
  if (!providerID || modelSegments.length === 0) return null;

  const last = modelSegments.at(-1);
  const hasSuffix = modelSegments.length > 1
    && (last === 'fusion' || (last !== undefined && /^\d+$/.test(last)));
  const suffix = hasSuffix ? modelSegments.pop() : undefined;
  const modelID = modelSegments.join('/');
  return parseSuffix(groupSlug, runGroup, providerID, modelID, suffix);
};

export const getMultiRunSessionTitle = (parts: {
  groupSlug: string;
  runGroup?: string;
  providerID: string;
  modelID: string;
  index?: number;
}): string => {
  const segments = [encodeURIComponent(parts.groupSlug)];
  if (parts.runGroup) segments.push(parts.runGroup);
  segments.push(encodeURIComponent(parts.providerID), encodeURIComponent(parts.modelID));
  if (parts.index !== undefined) segments.push(String(parts.index));
  return segments.join('/');
};

export const getFusionSessionTitle = (groupSlug: string, providerID: string, modelID: string, runGroup?: string): string => {
  const segments = [encodeURIComponent(groupSlug)];
  if (runGroup) segments.push(runGroup);
  segments.push(encodeURIComponent(providerID), encodeURIComponent(modelID), 'fusion');
  return segments.join('/');
};
