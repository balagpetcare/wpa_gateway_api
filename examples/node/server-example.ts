/**
 * WPA Gateway — Minimal Node.js HTTP Server Integration Example
 *
 * Demonstrates the complete server-side integration:
 *   POST /checkout/start   → creates WPA payment session, redirects to paymentUrl
 *   POST /wpa/webhook      → receives signed callback, verifies signature, updates order
 *   GET  /checkout/status  → polls order status (reads from in-memory "DB")
 *
 * Run:
 *   npx tsx examples/node/server-example.ts
 *
 * Then in another terminal:
 *   curl -X POST http://localhost:3001/checkout/start \
 *     -H 'Content-Type: application/json' \
 *     -d '{"orderId":"order_demo_1","amount":4999,"currency":"USD","customerName":"Jane Doe"}'
 *
 * Requires: WPA_CLIENT_ID, WPA_CLIENT_SECRET, WPA_GATEWAY_URL in environment or examples/node/.env
 */

import 'dotenv/config';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createPaymentSession, verifyGatewayWebhook, type GatewayWebhookPayload } from './wpa-sdk.js';

const GATEWAY_URL   = process.env.WPA_GATEWAY_URL   ?? 'http://localhost:4000';
const CLIENT_ID     = process.env.WPA_CLIENT_ID;
const CLIENT_SECRET = process.env.WPA_CLIENT_SECRET;
const PORT          = Number(process.env.EXAMPLE_PORT ?? 3001);

// ─── In-memory "database" ─────────────────────────────────────────────────────

interface Order {
  id: string;
  amount: number;
  currency: string;
  customerName: string;
  paymentStatus: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED';
  wpaReference: string | null;
  paidAt: string | null;
}

const orders = new Map<string, Order>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleCheckoutStart(req: IncomingMessage, res: ServerResponse) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    sendJson(res, 503, { error: 'WPA credentials not configured. Set WPA_CLIENT_ID and WPA_CLIENT_SECRET.' });
    return;
  }

  let body: { orderId: string; amount: number; currency: string; customerName: string; customerEmail?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.orderId || !body.amount || !body.currency || !body.customerName) {
    sendJson(res, 400, { error: 'Missing required fields: orderId, amount, currency, customerName' });
    return;
  }

  // Upsert order in local "DB"
  if (!orders.has(body.orderId)) {
    orders.set(body.orderId, {
      id: body.orderId,
      amount: body.amount,
      currency: body.currency,
      customerName: body.customerName,
      paymentStatus: 'PENDING',
      wpaReference: null,
      paidAt: null
    });
  }

  try {
    const session = await createPaymentSession(GATEWAY_URL, CLIENT_SECRET, {
      clientId: CLIENT_ID,
      merchantOrderId: body.orderId,
      amount: body.amount,
      currency: body.currency,
      customerName: body.customerName,
      customerEmail: body.customerEmail,
      description: `Payment for order ${body.orderId}`,
      successUrl: `http://localhost:${PORT}/checkout/success?orderId=${encodeURIComponent(body.orderId)}`,
      cancelUrl: `http://localhost:${PORT}/checkout/cancel?orderId=${encodeURIComponent(body.orderId)}`,
      callbackUrl: `http://localhost:${PORT}/wpa/callback`,
      webhookUrl: `http://localhost:${PORT}/wpa/webhook`
    });

    // Store gateway reference
    const order = orders.get(body.orderId)!;
    order.wpaReference = session.session.reference;
    orders.set(body.orderId, order);

    const paymentUrl = `${GATEWAY_URL}${session.session.paymentUrl}`;

    sendJson(res, 200, {
      success: true,
      orderId: body.orderId,
      reference: session.session.reference,
      paymentUrl,
      expiresAt: session.session.expiresAt,
      message: `Redirect customer to: ${paymentUrl}`
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[checkout/start] Error:', message);
    sendJson(res, 502, { error: message });
  }
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse) {
  const signature = req.headers['x-gateway-signature'];
  const event = req.headers['x-gateway-event'];

  if (typeof signature !== 'string' || typeof event !== 'string') {
    sendJson(res, 400, { error: 'Missing x-gateway-signature or x-gateway-event header' });
    return;
  }

  // Read RAW body — before any parsing
  const rawBody = await readRawBody(req);

  if (!CLIENT_SECRET) {
    sendJson(res, 503, { error: 'WPA_CLIENT_SECRET not configured' });
    return;
  }

  // Verify signature FIRST — before trusting any content
  const isValid = verifyGatewayWebhook(rawBody, CLIENT_SECRET, signature);
  if (!isValid) {
    console.warn('[webhook] ⚠️  Signature verification FAILED — rejecting');
    sendJson(res, 401, { error: 'Invalid signature' });
    return;
  }

  // Safe to parse now
  let payload: GatewayWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as GatewayWebhookPayload;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON payload' });
    return;
  }

  console.log(`[webhook] ✅ Verified event: ${payload.event} | order: ${payload.merchantOrderId}`);

  // Respond 200 immediately — process order update synchronously here (async in production)
  sendJson(res, 200, { received: true });

  const order = orders.get(payload.merchantOrderId);
  if (!order) {
    console.warn(`[webhook] Order not found locally: ${payload.merchantOrderId}`);
    return;
  }

  switch (payload.event) {
    case 'payment.succeeded':
      if (order.paymentStatus !== 'PAID') { // idempotent
        order.paymentStatus = 'PAID';
        order.paidAt = payload.paidAt ?? new Date().toISOString();
        orders.set(order.id, order);
        console.log(`[webhook] Order ${order.id} marked PAID — ${order.amount} ${order.currency}`);
      } else {
        console.log(`[webhook] Order ${order.id} already PAID — duplicate delivery ignored`);
      }
      break;

    case 'payment.failed':
      order.paymentStatus = 'FAILED';
      orders.set(order.id, order);
      console.log(`[webhook] Order ${order.id} marked FAILED`);
      break;

    case 'payment.cancelled':
      order.paymentStatus = 'CANCELLED';
      orders.set(order.id, order);
      console.log(`[webhook] Order ${order.id} marked CANCELLED`);
      break;

    default:
      console.log(`[webhook] Unhandled event: ${payload.event}`);
  }
}

function handleCheckoutStatus(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const orderId = url.searchParams.get('orderId');

  if (!orderId) {
    sendJson(res, 400, { error: 'Missing orderId query parameter' });
    return;
  }

  const order = orders.get(orderId);
  if (!order) {
    sendJson(res, 404, { error: 'Order not found' });
    return;
  }

  // Always read from YOUR database — never trust URL params to determine payment status
  sendJson(res, 200, {
    orderId: order.id,
    paymentStatus: order.paymentStatus,
    amount: order.amount,
    currency: order.currency,
    paidAt: order.paidAt,
    wpaReference: order.wpaReference
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const { method } = req;

  try {
    if (method === 'POST' && url.pathname === '/checkout/start') {
      await handleCheckoutStart(req, res);
    } else if (method === 'POST' && (url.pathname === '/wpa/webhook' || url.pathname === '/wpa/callback')) {
      await handleWebhook(req, res);
    } else if (method === 'GET' && url.pathname === '/checkout/status') {
      handleCheckoutStatus(req, res);
    } else if (method === 'GET' && (url.pathname === '/checkout/success' || url.pathname === '/checkout/cancel')) {
      // In production, redirect to your frontend and display order status from DB
      const orderId = url.searchParams.get('orderId') ?? 'unknown';
      const order = orders.get(orderId);
      sendJson(res, 200, {
        message: 'Payment flow complete — display status from your database, not this URL',
        orderId,
        // Read from DB, not from URL params
        paymentStatus: order?.paymentStatus ?? 'UNKNOWN (order not found)'
      });
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (error) {
    console.error('[server] Unhandled error:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\nWPA Integration Example Server running on http://localhost:${PORT}\n`);
  console.log('Endpoints:');
  console.log(`  POST /checkout/start    — Create WPA payment session`);
  console.log(`  POST /wpa/webhook       — Receive signed gateway callback`);
  console.log(`  GET  /checkout/status   — Poll order status (reads from DB)\n`);
  console.log('Example:');
  console.log(`  curl -X POST http://localhost:${PORT}/checkout/start \\`);
  console.log(`    -H 'Content-Type: application/json' \\`);
  console.log(`    -d '{"orderId":"order_demo_1","amount":4999,"currency":"USD","customerName":"Jane Doe"}'\n`);

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('⚠️  WPA_CLIENT_ID / WPA_CLIENT_SECRET not set — payment session creation will fail.');
    console.warn('   Set them in examples/node/.env\n');
  }
});
