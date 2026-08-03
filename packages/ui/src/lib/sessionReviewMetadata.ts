import type { Session } from '@opencode-ai/sdk/v2';

export type SessionMetadataRecord = Record<string, unknown>;

type PiariumMetadata = {
  kind?: 'review';
  originalSessionID?: string;
  reviewSessionID?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const getSessionMetadata = (session: Session | null | undefined): SessionMetadataRecord => {
  const metadata = (session as (Session & { metadata?: unknown }) | null | undefined)?.metadata;
  return isRecord(metadata) ? metadata : {};
};

const getPiariumMetadata = (metadata: SessionMetadataRecord): PiariumMetadata => {
  const value = metadata.piarium;
  return isRecord(value) ? value as PiariumMetadata : {};
};

export const getReviewSessionID = (session: Session | null | undefined): string | null => {
  const value = getPiariumMetadata(getSessionMetadata(session)).reviewSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const getOriginalSessionID = (session: Session | null | undefined): string | null => {
  const value = getPiariumMetadata(getSessionMetadata(session)).originalSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const isReviewSession = (session: Session | null | undefined): boolean =>
  getPiariumMetadata(getSessionMetadata(session)).kind === 'review' && Boolean(getOriginalSessionID(session));

export const withReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getPiariumMetadata(metadata);
  return {
    ...metadata,
    piarium: {
      ...current,
      reviewSessionID,
    },
  };
};

export const withReviewSessionMarker = (
  metadata: SessionMetadataRecord,
  originalSessionID: string,
): SessionMetadataRecord => {
  const current = getPiariumMetadata(metadata);
  return {
    ...metadata,
    piarium: {
      ...current,
      kind: 'review' as const,
      originalSessionID,
    },
  };
};

export const withoutReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getPiariumMetadata(metadata);
  if (current.reviewSessionID !== reviewSessionID) return metadata;

  const restPiarium = { ...current };
  delete restPiarium.reviewSessionID;
  const next: SessionMetadataRecord = { ...metadata };
  if (Object.keys(restPiarium).length > 0) {
    next.piarium = restPiarium;
  } else {
    delete next.piarium;
  }
  return next;
};
