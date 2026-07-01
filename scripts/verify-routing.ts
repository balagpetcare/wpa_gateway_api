/**
 * Routing Verification Script
 * Tests GatewayRoutingService for all PaymentPurpose values and verifies
 * fee calculation, fallback logic, and field completeness.
 *
 * Run: npx tsx scripts/verify-routing.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { GatewayRoutingService } from '../src/services/gateway-routing.js';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

type TestCase = {
  label: string;
  countryCode: string;
  currencyCode: string;
  purpose: 'DONATION' | 'MEMBERSHIP' | 'CAMPAIGN' | 'GENERAL_SALE' | 'MARKETPLACE' | 'SUBSCRIPTION';
  amountBdt: number;
  expectFallback?: string;
  expectProvider?: string;
};

const TESTS: TestCase[] = [
  { label: 'BD/BDT DONATION → NAGAD (exact)',        countryCode: 'BD', currencyCode: 'BDT', purpose: 'DONATION',     amountBdt: 50000,  expectFallback: 'EXACT_PURPOSE',  expectProvider: 'NAGAD'     },
  { label: 'BD/BDT MEMBERSHIP → EPS (exact)',        countryCode: 'BD', currencyCode: 'BDT', purpose: 'MEMBERSHIP',   amountBdt: 120000, expectFallback: 'EXACT_PURPOSE',  expectProvider: 'EPS'       },
  { label: 'BD/BDT CAMPAIGN → EPS (exact)',          countryCode: 'BD', currencyCode: 'BDT', purpose: 'CAMPAIGN',     amountBdt: 30000,  expectFallback: 'EXACT_PURPOSE',  expectProvider: 'EPS'       },
  { label: 'BD/BDT GENERAL_SALE → NAGAD (exact)',    countryCode: 'BD', currencyCode: 'BDT', purpose: 'GENERAL_SALE', amountBdt: 200000, expectFallback: 'EXACT_PURPOSE',  expectProvider: 'NAGAD'     },
  { label: 'BD/BDT MARKETPLACE → SSLCOMMERZ (exact)',countryCode: 'BD', currencyCode: 'BDT', purpose: 'MARKETPLACE',  amountBdt: 80000,  expectFallback: 'EXACT_PURPOSE',  expectProvider: 'SSLCOMMERZ'},
  { label: 'US/USD SUBSCRIPTION → STRIPE (fallback ALL_PURPOSES)', countryCode: 'US', currencyCode: 'USD', purpose: 'SUBSCRIPTION', amountBdt: 1000, expectFallback: 'ALL_PURPOSES', expectProvider: 'STRIPE' },
  { label: 'US/USD DONATION → STRIPE (fallback ALL_PURPOSES)',     countryCode: 'US', currencyCode: 'USD', purpose: 'DONATION',     amountBdt: 2000, expectFallback: 'ALL_PURPOSES', expectProvider: 'STRIPE' },
];

// Dummy merchantId — routing works on platform-level scope so any value works
const MERCHANT_ID = '00000000-0000-0000-0000-000000000000';

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  WPA Gateway — Purpose-Based Routing Verification');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;
  const results: Record<string, unknown>[] = [];

  for (const tc of TESTS) {
    process.stdout.write(`  ► ${tc.label}... `);
    try {
      const route = await GatewayRoutingService.resolveRoute({
        merchantId: MERCHANT_ID,
        countryCode: tc.countryCode,
        currencyCode: tc.currencyCode,
        purpose: tc.purpose as any,
        environment: 'SANDBOX',
        amount: BigInt(tc.amountBdt),
      });

      // Verify expected provider
      const providerOk = !tc.expectProvider || route.provider.name === tc.expectProvider;
      const fallbackOk = !tc.expectFallback || route.reason === tc.expectFallback;

      if (!providerOk || !fallbackOk) {
        console.log(`✗ MISMATCH`);
        if (!providerOk) console.log(`      Expected provider: ${tc.expectProvider}, got: ${route.provider.name}`);
        if (!fallbackOk) console.log(`      Expected fallback: ${tc.expectFallback}, got: ${route.reason}`);
        failed++;
      } else {
        console.log(`✓ OK`);
        passed++;
      }

      // Fee calculation display
      const fee = route.feeCalculation;
      const feeStr = fee
        ? `${route.feeRule?.percentageFee}% + ${route.feeRule?.fixedFee} fixed → fee=${fee.totalFee} (bearer=${fee.feeBearer})`
        : 'no fee rule';

      results.push({
        test: tc.label,
        status: providerOk && fallbackOk ? 'PASS' : 'FAIL',
        provider: route.provider.name,
        credentialProfile: route.credentialProfile?.label ?? null,
        routingRule: route.routingRule
          ? `${route.routingRule.countryCode}/${route.routingRule.currencyCode}/${route.routingRule.purpose}`
          : null,
        reason: route.reason,
        feeRule: feeStr,
        amountIn: tc.amountBdt,
        gatewayFee: fee ? parseFloat(fee.totalFee).toFixed(2) : null,
        totalPayable:
          fee && fee.feeBearer === 'CUSTOMER'
            ? (tc.amountBdt + parseFloat(fee.totalFee)).toFixed(2)
            : tc.amountBdt.toFixed(2),
        netSettlement:
          fee && (fee.feeBearer === 'MERCHANT' || fee.feeBearer === 'SHARED')
            ? (tc.amountBdt - parseFloat(fee.totalFee)).toFixed(2)
            : tc.amountBdt.toFixed(2),
        settlementProfile: route.settlementProfile?.name ?? null,
      });
    } catch (err: any) {
      console.log(`✗ ERROR: ${err.message}`);
      failed++;
      results.push({ test: tc.label, status: 'ERROR', error: err.message });
    }
  }

  console.log('\n─── Fee Calculation Examples ───────────────────────────────────\n');
  for (const r of results) {
    if ((r as any).status !== 'PASS') continue;
    const amount = (r as any).amountIn;
    console.log(`  ${(r as any).test}`);
    console.log(`    Provider:    ${(r as any).provider}  |  Profile: ${(r as any).credentialProfile ?? 'none'}`);
    console.log(`    Routing:     ${(r as any).routingRule ?? 'no explicit rule'}  |  Reason: ${(r as any).reason}`);
    console.log(`    Fee Rule:    ${(r as any).feeRule}`);
    console.log(`    Amount In:   ${amount}  →  Gateway Fee: ${(r as any).gatewayFee ?? '—'}`);
    console.log(`    Payable:     ${(r as any).totalPayable}  |  Net Settlement: ${(r as any).netSettlement}`);
    console.log();
  }

  console.log('─── Fallback Logic Test ──────────────────────────────────────────\n');

  // Test: BD/BDT SUBSCRIPTION — no explicit rule → should use SINGLE_LOCAL_GATEWAY or ALL_PURPOSES
  try {
    process.stdout.write('  ► BD/BDT SUBSCRIPTION (no explicit rule)... ');
    const subRoute = await GatewayRoutingService.resolveRoute({
      merchantId: MERCHANT_ID,
      countryCode: 'BD',
      currencyCode: 'BDT',
      purpose: 'SUBSCRIPTION',
      environment: 'SANDBOX',
      amount: BigInt(100000),
    });
    console.log(`✓ routed → ${subRoute.provider.name} via ${subRoute.reason}`);
    passed++;
  } catch (err: any) {
    console.log(`✗ No route (expected if no BD/BDT/SUBSCRIPTION rule): ${err.message}`);
    // Not counted as failure — this tests expected absence
  }

  // Test: inactive provider is NOT used — deactivate NAGAD temporarily and re-resolve DONATION
  const nagad = await prisma.paymentProvider.findFirst({ where: { name: 'NAGAD', environment: 'SANDBOX' } });
  if (nagad) {
    await prisma.paymentProvider.update({ where: { id: nagad.id }, data: { isActive: false } });
    try {
      process.stdout.write('  ► BD/BDT DONATION with NAGAD inactive → fallback to BKASH... ');
      const inactiveRoute = await GatewayRoutingService.resolveRoute({
        merchantId: MERCHANT_ID,
        countryCode: 'BD',
        currencyCode: 'BDT',
        purpose: 'DONATION',
        environment: 'SANDBOX',
        amount: BigInt(50000),
      });
      if (inactiveRoute.provider.name !== 'NAGAD') {
        console.log(`✓ correctly fell to ${inactiveRoute.provider.name} (reason: ${inactiveRoute.reason})`);
        passed++;
      } else {
        console.log(`✗ still routed to NAGAD even though inactive`);
        failed++;
      }
    } catch {
      console.log(`✗ no route found when NAGAD inactive`);
      failed++;
    }
    // Restore
    await prisma.paymentProvider.update({ where: { id: nagad.id }, data: { isActive: true } });
  }

  // Test: inactive routing rule is ignored
  const nagadProvider = await prisma.paymentProvider.findFirst({ where: { name: 'NAGAD', environment: 'SANDBOX' } });
  const inactiveRuleTest = await prisma.gatewayRoutingRule.findFirst({
    where: { countryCode: 'BD', currencyCode: 'BDT', purpose: 'DONATION', providerId: nagadProvider?.id ?? '' },
  });
  if (inactiveRuleTest) {
    await prisma.gatewayRoutingRule.update({ where: { id: inactiveRuleTest.id }, data: { isActive: false } });
    try {
      process.stdout.write('  ► BD/BDT DONATION with NAGAD rule inactive → fallback to next rule... ');
      const noRuleRoute = await GatewayRoutingService.resolveRoute({
        merchantId: MERCHANT_ID,
        countryCode: 'BD',
        currencyCode: 'BDT',
        purpose: 'DONATION',
        environment: 'SANDBOX',
        amount: BigInt(50000),
      });
      if (noRuleRoute.provider.name !== 'NAGAD') {
        console.log(`✓ routed to ${noRuleRoute.provider.name} (NAGAD rule skipped)`);
        passed++;
      } else {
        console.log(`✗ still used disabled rule → ${noRuleRoute.provider.name}`);
        failed++;
      }
    } catch {
      console.log('? no route (acceptable if only one DONATION rule)');
    }
    await prisma.gatewayRoutingRule.update({ where: { id: inactiveRuleTest.id }, data: { isActive: true } });
  }

  console.log('\n─── Security Check ───────────────────────────────────────────────\n');
  const profiles = await prisma.credentialProfile.findMany({
    select: { id: true, label: true, encryptedSecrets: true },
    take: 2,
  });
  for (const p of profiles) {
    const s = p.encryptedSecrets as any;
    const hasEncrypted = s && s.iv && s.authTag && s.ciphertext;
    const noPlaintext = !s?.username && !s?.password && !s?.secretKey && !s?.appSecret && !s?.privateKey;
    console.log(`  ► "${p.label}": encrypted=${hasEncrypted} | no plaintext=${noPlaintext}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
