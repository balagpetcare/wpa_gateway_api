import { env } from '../../config/env.js';

const trimSlashes = (value: string) => value.replace(/\/+$/, '');

const buildBookingSlipUrl = (bookingRef: string) => {
  const baseUrl = env.PUBLIC_SITE_URL ? trimSlashes(env.PUBLIC_SITE_URL) : null;
  if (!baseUrl) {
    return null;
  }

  return `${baseUrl}/booking/${encodeURIComponent(bookingRef)}`;
};

const toStringValue = (value: unknown) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toNumberValue = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

export const buildVaccinationSessionMetadata = (input: {
  merchantOrderId: string;
  description?: string;
  metadata?: Record<string, unknown>;
}) => {
  const metadata = input.metadata ?? {};
  const isVaccinationCandidate =
    toStringValue(metadata.bookingRef) !== null ||
    toStringValue(metadata.campaignName) !== null ||
    toStringValue(metadata.bookingSlipUrl) !== null ||
    toNumberValue(metadata.petCount) !== null ||
    toStringValue(metadata.venueName) !== null ||
    toStringValue(metadata.sessionDate) !== null ||
    toStringValue(metadata.sessionTime) !== null ||
    toStringValue(metadata.supportPhone) !== null ||
    /vaccination/i.test(input.description ?? '');

  if (!isVaccinationCandidate) {
    return metadata;
  }

  const bookingRef = toStringValue(metadata.bookingRef) ?? input.merchantOrderId;
  const campaignName = toStringValue(metadata.campaignName) ?? toStringValue(input.description) ?? 'Vaccination Campaign';
  const bookingSlipUrl = toStringValue(metadata.bookingSlipUrl) ?? buildBookingSlipUrl(bookingRef);

  return {
    ...metadata,
    bookingRef,
    campaignName,
    bookingSlipUrl,
    petCount: toNumberValue(metadata.petCount) ?? undefined,
    venueName: toStringValue(metadata.venueName) ?? undefined,
    sessionDate: toStringValue(metadata.sessionDate) ?? undefined,
    sessionTime: toStringValue(metadata.sessionTime) ?? undefined,
    supportPhone: toStringValue(metadata.supportPhone) ?? '01701022274'
  };
};
