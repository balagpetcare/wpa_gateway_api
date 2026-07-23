import { runGatewayRoutingTests } from './services/gateway-routing.test.js';
import { runEPSAdapterTests } from './providers/eps.test.js';
import { runBkashAdapterTests } from './providers/bkash.test.js';
import { runSSLCommerzAdapterTests } from './providers/sslcommerz.test.js';
import { runNagadAdapterTests } from './providers/nagad.test.js';
import { runLocalAdminAuthTests } from './modules/auth/local-admin-auth.test.js';

async function main() {
  try {
    await runGatewayRoutingTests();
    await runEPSAdapterTests();
    await runBkashAdapterTests();
    await runNagadAdapterTests();
    await runSSLCommerzAdapterTests();
    await runLocalAdminAuthTests();
    process.exit(0);
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exit(1);
  }
}

main();
