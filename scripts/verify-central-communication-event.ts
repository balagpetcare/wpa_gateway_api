import assert from 'node:assert/strict';
import { buildCentralCommunicationRequest } from '../src/services/central-communication.js';

const result = buildCentralCommunicationRequest({
  customer: {
    name: 'Md Rahim',
    phone: '8801701022274',
    email: 'rahim@example.com'
  },
  metadata: {
    bookingRef: 'BPA-VAC-2026-000123',
    campaignName: 'BPA Cat Vaccination Campaign 2026',
    bookingSlipUrl: 'https://bangladeshpetassociation.com/booking/BPA-VAC-2026-000123',
    supportPhone: '01701022274',
    petCount: 1,
    venueName: 'Rampura Venue',
    sessionDate: '2026-07-10',
    sessionTime: '10:00 AM - 01:00 PM'
  },
  amountMinor: 600n,
  currency: 'BDT',
  paymentRef: 'EPS-TXN-987654'
});

assert.equal(result.ok, true, 'Expected request builder to accept the sample payload');
if (!result.ok) {
  throw new Error(result.reason);
}

assert.deepEqual(result.payload.channels, ['sms', 'email']);
assert.equal(result.payload.recipient.phone, '01701022274');
assert.equal(result.payload.recipient.email, 'rahim@example.com');
assert.equal(result.payload.data.bookingRef, 'BPA-VAC-2026-000123');
assert.equal(result.payload.data.paymentRef, 'EPS-TXN-987654');
assert.equal(result.payload.data.amount, 600);
assert.equal(result.payload.data.currency, 'BDT');
assert.equal(result.idempotencyKey, 'payment:EPS-TXN-987654:booking:BPA-VAC-2026-000123');

console.log('PASS: Central communication request builder produced the expected payload and idempotency key.');
