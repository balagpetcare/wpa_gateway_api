import assert from 'node:assert/strict';

process.env.PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL ?? 'https://bangladeshpetassociation.com';

const { buildVaccinationSessionMetadata } = await import('../src/modules/payment-sessions/vaccination-metadata.js');

const metadata = buildVaccinationSessionMetadata({
  merchantOrderId: 'BPA-VAC-2026-000123',
  description: 'BPA Cat Vaccination Campaign 2026',
  metadata: {
    bookingRef: 'BPA-VAC-2026-000123',
    campaignName: 'BPA Cat Vaccination Campaign 2026',
    petCount: 1,
    venueName: 'Rampura Venue',
    sessionDate: '2026-07-10',
    sessionTime: '10:00 AM - 01:00 PM',
    supportPhone: '01701022274'
  }
});

assert.equal(metadata.bookingRef, 'BPA-VAC-2026-000123');
assert.equal(metadata.campaignName, 'BPA Cat Vaccination Campaign 2026');
assert.equal(metadata.bookingSlipUrl, 'https://bangladeshpetassociation.com/booking/BPA-VAC-2026-000123');
assert.equal(metadata.petCount, 1);
assert.equal(metadata.venueName, 'Rampura Venue');
assert.equal(metadata.sessionDate, '2026-07-10');
assert.equal(metadata.sessionTime, '10:00 AM - 01:00 PM');
assert.equal(metadata.supportPhone, '01701022274');

console.log('PASS: Vaccination metadata contract includes the Central Auth event fields.');

