import { prisma } from '../config/prisma.js';
import { GatewayRoutingService } from './gateway-routing.js';

export async function runGatewayRoutingTests() {
  console.log('--- Starting Gateway Routing Service Tests ---');
  let exitCode = 0;

  // Set up common merchant and providers
  await prisma.gatewayRoutingRule.deleteMany();
  await prisma.gatewayFeeRule.deleteMany();
  await prisma.credentialProfile.deleteMany();
  await prisma.settlementProfile.deleteMany();
  await prisma.paymentProvider.deleteMany();
  await prisma.merchant.deleteMany();

  const merchant = await prisma.merchant.create({
    data: {
      id: 'test-merchant-1',
      name: 'Test Merchant',
      businessName: 'Test Business',
      contactEmail: 'routing-test@example.com',
      environment: 'SANDBOX'
    }
  });

  const localProvider = await prisma.paymentProvider.create({
    data: {
      id: 'local-provider-1',
      name: 'BKASH',
      displayName: 'bKash Wallet',
      coverageType: 'LOCAL',
      environment: 'SANDBOX',
      isActive: true
    }
  });

  const globalProvider = await prisma.paymentProvider.create({
    data: {
      id: 'global-provider-1',
      name: 'STRIPE',
      displayName: 'Stripe International',
      coverageType: 'GLOBAL',
      environment: 'SANDBOX',
      isActive: true
    }
  });

  // Test 1: donation exact rule
  try {
    const cpDonation = await prisma.credentialProfile.create({
      data: {
        id: 'cp-donation-1',
        providerId: globalProvider.id,
        label: 'Stripe Donation Profile',
        environment: 'SANDBOX',
        supportedPurposes: ['DONATION'],
        countryCodes: ['BD'],
        currencyCodes: ['BDT'],
        encryptedSecrets: {}
      }
    });

    await prisma.gatewayRoutingRule.create({
      data: {
        id: 'rule-donation-1',
        providerId: globalProvider.id,
        credentialProfileId: cpDonation.id,
        countryCode: 'BD',
        currencyCode: 'BDT',
        purpose: 'DONATION',
        environment: 'SANDBOX',
        scopeType: 'MERCHANT',
        scopeId: merchant.id,
        isActive: true
      }
    });

    const result = await GatewayRoutingService.resolveRoute({
      merchantId: merchant.id,
      countryCode: 'BD',
      currencyCode: 'BDT',
      purpose: 'DONATION',
      environment: 'SANDBOX',
      amount: 1000n
    });

    if (result.reason === 'EXACT_PURPOSE' && result.provider.id === globalProvider.id) {
      console.log('✅ Test 1 Passed: donation exact rule matches correctly.');
    } else {
      console.error('❌ Test 1 Failed: expected EXACT_PURPOSE Stripe, got:', result.reason, result.provider.name);
      exitCode = 1;
    }
  } catch (err: any) {
    console.error('❌ Test 1 Error:', err.message);
    exitCode = 1;
  }

  // Test 2: membership exact rule
  try {
    const cpMembership = await prisma.credentialProfile.create({
      data: {
        id: 'cp-membership-1',
        providerId: localProvider.id,
        label: 'bKash Membership Profile',
        environment: 'SANDBOX',
        supportedPurposes: ['MEMBERSHIP'],
        countryCodes: ['BD'],
        currencyCodes: ['BDT'],
        encryptedSecrets: {}
      }
    });

    await prisma.gatewayRoutingRule.create({
      data: {
        id: 'rule-membership-1',
        providerId: localProvider.id,
        credentialProfileId: cpMembership.id,
        countryCode: 'BD',
        currencyCode: 'BDT',
        purpose: 'MEMBERSHIP',
        environment: 'SANDBOX',
        scopeType: 'PLATFORM',
        isActive: true
      }
    });

    const result = await GatewayRoutingService.resolveRoute({
      merchantId: merchant.id,
      countryCode: 'BD',
      currencyCode: 'BDT',
      purpose: 'MEMBERSHIP',
      environment: 'SANDBOX',
      amount: 2000n
    });

    if (result.reason === 'EXACT_PURPOSE' && result.provider.id === localProvider.id) {
      console.log('✅ Test 2 Passed: membership exact rule matches correctly.');
    } else {
      console.error('❌ Test 2 Failed: expected EXACT_PURPOSE bKash, got:', result.reason, result.provider.name);
      exitCode = 1;
    }
  } catch (err: any) {
    console.error('❌ Test 2 Error:', err.message);
    exitCode = 1;
  }

  // Cleanup rules/profiles for local fallback tests
  await prisma.gatewayRoutingRule.deleteMany();
  await prisma.credentialProfile.deleteMany();

  // Test 3: country with only one local gateway serving all purposes
  try {
    const cpSingleLocal = await prisma.credentialProfile.create({
      data: {
        id: 'cp-local-only-1',
        providerId: localProvider.id,
        label: 'bKash Single Local',
        environment: 'SANDBOX',
        supportedPurposes: ['ALL_PURPOSES'],
        countryCodes: ['BD'],
        currencyCodes: ['BDT'],
        encryptedSecrets: {}
      }
    });

    // Try routing for CAMPAIGN purpose which has no exact rule
    const result = await GatewayRoutingService.resolveRoute({
      merchantId: merchant.id,
      countryCode: 'BD',
      currencyCode: 'BDT',
      purpose: 'CAMPAIGN',
      environment: 'SANDBOX',
      amount: 1500n
    });

    if (result.reason === 'SINGLE_LOCAL_GATEWAY' && result.provider.id === localProvider.id) {
      console.log('✅ Test 3 Passed: single local gateway fallback matched correctly.');
    } else {
      console.error('❌ Test 3 Failed: expected SINGLE_LOCAL_GATEWAY bKash, got:', result.reason, result.provider.name);
      exitCode = 1;
    }
  } catch (err: any) {
    console.error('❌ Test 3 Error:', err.message);
    exitCode = 1;
  }

  // Test 4: country with no local gateway using Stripe/PayPal fallback
  try {
    // Delete local credential profiles to ensure no local matches
    await prisma.credentialProfile.deleteMany();

    // Create a global profile for Stripe supporting CAMPAIGN
    const cpStripeGlobal = await prisma.credentialProfile.create({
      data: {
        id: 'cp-stripe-global-1',
        providerId: globalProvider.id,
        label: 'Stripe Global Fallback',
        environment: 'SANDBOX',
        supportedPurposes: ['CAMPAIGN'],
        countryCodes: ['BD'],
        currencyCodes: ['BDT'],
        encryptedSecrets: {}
      }
    });

    const result = await GatewayRoutingService.resolveRoute({
      merchantId: merchant.id,
      countryCode: 'BD',
      currencyCode: 'BDT',
      purpose: 'CAMPAIGN',
      environment: 'SANDBOX',
      amount: 5000n
    });

    if (result.reason === 'GLOBAL_FALLBACK' && result.provider.id === globalProvider.id) {
      console.log('✅ Test 4 Passed: global/international fallback matched correctly.');
    } else {
      console.error('❌ Test 4 Failed: expected GLOBAL_FALLBACK Stripe, got:', result.reason, result.provider.name);
      exitCode = 1;
    }
  } catch (err: any) {
    console.error('❌ Test 4 Error:', err.message);
    exitCode = 1;
  }

  // Test 5: inactive gateway ignored
  try {
    // Make global provider inactive
    await prisma.paymentProvider.update({
      where: { id: globalProvider.id },
      data: { isActive: false }
    });

    try {
      await GatewayRoutingService.resolveRoute({
        merchantId: merchant.id,
        countryCode: 'BD',
        currencyCode: 'BDT',
        purpose: 'CAMPAIGN',
        environment: 'SANDBOX',
        amount: 5000n
      });
      console.error('❌ Test 5 Failed: routing should have failed for inactive provider fallback');
      exitCode = 1;
    } catch (err: any) {
      if (err.message.includes('No payment gateway available')) {
        console.log('✅ Test 5 Passed: inactive gateway correctly ignored.');
      } else {
        console.error('❌ Test 5 Failed with unexpected error:', err.message);
        exitCode = 1;
      }
    }

    // Re-enable global provider
    await prisma.paymentProvider.update({
      where: { id: globalProvider.id },
      data: { isActive: true }
    });
  } catch (err: any) {
    console.error('❌ Test 5 Error:', err.message);
    exitCode = 1;
  }

  // Cleanup test database entries
  await prisma.gatewayRoutingRule.deleteMany();
  await prisma.gatewayFeeRule.deleteMany();
  await prisma.credentialProfile.deleteMany();
  await prisma.settlementProfile.deleteMany();
  await prisma.paymentProvider.deleteMany();
  await prisma.merchant.deleteMany();

  if (exitCode !== 0) {
    console.error('❌ One or more routing tests failed!');
    process.exit(exitCode);
  } else {
    console.log('🎉 All Gateway Routing tests passed successfully!');
  }
}
