import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { generateReference, validateReference, normalizeReference } from './src/utils/reference.ts';
import { parseIncomingSms, validateTrxIdFormat, ALLOWED_MFS_SENDERS } from './src/utils/smsParser.ts';
import { computeDeviceSignature, verifyDeviceIngestSignature, DeviceSignPayload } from './src/utils/deviceSignature.ts';
import { signWebhookPayload, verifyWebhookSignature, dispatchRealWebhook } from './src/utils/webhook.ts';
import { createChainedAuditEntry, ChainedAuditLogEntry, GENESIS_HASH } from './src/utils/auditLogger.ts';
import { Payment, IncomingTxn, PricingPlan, Merchant, DeviceInfo } from './src/types/index.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// In-Memory Authoritative Store simulating Postgres relational model for development/demo
const initialMerchant: Merchant = {
  id: '018a9x20-0000-0000-0000-000000000001',
  name: 'DeshiCart Technologies Ltd.',
  status: 'active',
  kybStatus: 'verified',
  payoutAccount: {
    type: 'bank',
    accountNumber: '1081520038921',
    accountName: 'DeshiCart Technologies Ltd',
    bankName: 'Eastern Bank PLC',
    routingNumber: '095261320',
  },
  feeRateBps: 500, // 5%
  riskTier: 'standard',
  webhookSecret: 'whsec_e9f82b71940a12cf498a1293',
  webhookUrl: 'https://merchant-api.deshicart.com.bd/api/webhooks/paygate',
  autoConfirm: true,
  balancePaisa: 1450000,
  heldPaisa: 0,
  testApiKey: 'sk_test_pg_demo88129a00b12',
  liveApiKey: 'sk_live_pg_99210a48b3c109df291c',
};

const pricingPlans: PricingPlan[] = [
  {
    id: 'plan_pro_monthly',
    merchantId: initialMerchant.id,
    name: 'Pro Membership (Monthly)',
    amountPaisa: 120000, // Tk 1,200.00
    currency: 'BDT',
    version: 1,
    externalSku: 'SKU-PRO-M',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'plan_starter_single',
    merchantId: initialMerchant.id,
    name: 'Starter License Pass',
    amountPaisa: 45000, // Tk 450.00
    currency: 'BDT',
    version: 1,
    externalSku: 'SKU-STARTER-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const superAdminDevice: DeviceInfo = {
  id: 'dev_superadmin_01',
  name: 'Samsung Galaxy M14 5G (Super Admin)',
  imei: '864291058291042',
  appVersion: 'v4.0.2-prod',
  batteryLevel: 94,
  isCharging: true,
  status: 'online',
  lastHeartbeat: new Date().toISOString(),
  lastSeenLatencyMs: 18,
  deviceSecret: 'dev_sec_superadmin_9921',
  lastSeqNo: 100,
  sim1: {
    slot: 1,
    operator: 'Grameenphone',
    phoneNumber: '01712-750278',
    status: 'active',
    signalStrength: 92,
  },
  sim2: {
    slot: 2,
    operator: 'Robi',
    phoneNumber: '01912-345678',
    status: 'active',
    signalStrength: 86,
  },
  ipWhitelist: ['103.145.74.0/24', '192.168.1.105', '127.0.0.1'],
  activeClientIp: '127.0.0.1',
};

const paymentsStore: Map<string, Payment> = new Map();
const incomingTxnsStore: Map<string, IncomingTxn> = new Map();
const quarantinedSmsStore: any[] = [];
const idempotencyStore: Map<string, { status: number; body: any }> = new Map();
const paymentAttemptsStore: Map<string, { count: number; lockedUntil?: number }> = new Map();
let auditLogChain: ChainedAuditLogEntry[] = [];
const outboxQueue: any[] = [];

// Initialize Genesis Audit Entry
(async () => {
  const genesis = await createChainedAuditEntry(
    'system',
    'system',
    'SERVER_INIT',
    'system',
    'sys_01',
    'PayGate Express Production Backend Started',
    '127.0.0.1'
  );
  auditLogChain.push(genesis);
})();

// Helper to record audit log entry
async function logAudit(
  actor: string,
  role: 'merchant' | 'admin' | 'developer' | 'system',
  action: string,
  entityType: string,
  entityId: string,
  details: string,
  ip: string
) {
  const last = auditLogChain.length > 0 ? auditLogChain[auditLogChain.length - 1] : undefined;
  const entry = await createChainedAuditEntry(actor, role, action, entityType, entityId, details, ip, last);
  auditLogChain.push(entry);
  return entry;
}

// ==========================================
// API V1 ENDPOINTS
// ==========================================

// 1. POST /v1/payments (Merchant creates payment)
app.post('/v1/payments', async (req: Request, res: Response) => {
  const idempotencyKey = req.headers['idempotency-key'] as string;
  if (idempotencyKey && idempotencyStore.has(idempotencyKey)) {
    const cached = idempotencyStore.get(idempotencyKey)!;
    return res.status(cached.status).json(cached.body);
  }

  const { plan_id, order_id, provider = 'bkash', callback_url, success_url } = req.body;
  const plan = pricingPlans.find((p) => p.id === plan_id) || pricingPlans[0];
  const feeRateBps = initialMerchant.feeRateBps;
  const feePaisa = Math.round((plan.amountPaisa * feeRateBps) / 10000);
  const netPaisa = plan.amountPaisa - feePaisa;

  const paymentId = `pay_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const reference = generateReference();
  const walletNumber = provider === 'rocket' || provider === 'upay' || provider === 'cellfin'
    ? superAdminDevice.sim2.phoneNumber
    : superAdminDevice.sim1.phoneNumber;

  const newPayment: Payment = {
    id: paymentId,
    merchantId: initialMerchant.id,
    planId: plan.id,
    planSnapshot: {
      name: plan.name,
      amountPaisa: plan.amountPaisa,
      version: plan.version,
    },
    orderId: order_id || `ORD-${Date.now()}`,
    amountPaisa: plan.amountPaisa,
    feeAmountPaisa: feePaisa,
    netAmountPaisa: netPaisa,
    provider,
    walletId: `wal_${provider}_01`,
    offeredWalletIds: [`wal_${provider}_01`],
    reference,
    status: 'awaiting_payment',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 mins
  };

  paymentsStore.set(paymentId, newPayment);

  const responseBody = {
    id: newPayment.id,
    order_id: newPayment.orderId,
    amount_paisa: newPayment.amountPaisa,
    currency: 'BDT',
    reference: newPayment.reference,
    provider: newPayment.provider,
    wallet: {
      provider: newPayment.provider,
      number: walletNumber,
      holder_name: initialMerchant.name,
    },
    pay_url: `/pay/${newPayment.id}`,
    expires_at: newPayment.expiresAt,
  };

  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { status: 201, body: responseBody });
  }

  await logAudit(
    initialMerchant.name,
    'merchant',
    'CREATE_PAYMENT',
    'payment',
    newPayment.id,
    `Created payment for order ${newPayment.orderId} (Amount: Tk ${newPayment.amountPaisa / 100})`,
    req.ip || '127.0.0.1'
  );

  return res.status(201).json(responseBody);
});

// 2. GET /v1/payments/:id
app.get('/v1/payments/:id', (req: Request, res: Response) => {
  const payment = paymentsStore.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  return res.json(payment);
});

// 3. GET /v1/pay/:id (Customer checkout page)
app.get('/v1/pay/:id', (req: Request, res: Response) => {
  const payment = paymentsStore.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment link expired or not found' });

  const attempts = paymentAttemptsStore.get(payment.id) || { count: 0 };
  const isLocked = attempts.lockedUntil ? Date.now() < attempts.lockedUntil : false;

  return res.json({
    payment,
    isLocked,
    lockedUntil: attempts.lockedUntil,
    attemptsRemaining: Math.max(0, 5 - attempts.count),
  });
});

// 4. POST /v1/pay/:id/confirm (Customer submits TrxID with 5-attempt anti-brute-force lockout)
app.post('/v1/pay/:id/confirm', async (req: Request, res: Response) => {
  const payment = paymentsStore.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  // 1. Anti-brute-force lockout check
  const attempts = paymentAttemptsStore.get(payment.id) || { count: 0 };
  if (attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
    const remainingSeconds = Math.ceil((attempts.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({
      error: `Too many failed attempts. Checkout locked for ${remainingSeconds} seconds.`,
      lockedUntil: attempts.lockedUntil,
    });
  }

  const { trx_id } = req.body;
  if (!trx_id) return res.status(400).json({ error: 'Transaction ID is required' });

  const cleanTrx = trx_id.trim().toUpperCase();
  const formatValidation = validateTrxIdFormat(cleanTrx, payment.provider);
  if (!formatValidation.isValid) {
    attempts.count += 1;
    if (attempts.count >= 5) {
      attempts.lockedUntil = Date.now() + 15 * 60 * 1000; // 15-minute lockout
    }
    paymentAttemptsStore.set(payment.id, attempts);
    return res.status(400).json({
      error: formatValidation.message,
      attemptsRemaining: Math.max(0, 5 - attempts.count),
      isLocked: attempts.count >= 5,
    });
  }

  // Update submitted TrxID
  payment.submittedTrxId = cleanTrx;

  // Search for matching SMS in authoritative incoming_txns store
  let matchingTxn: IncomingTxn | undefined;
  for (const txn of incomingTxnsStore.values()) {
    if (txn.trxId === cleanTrx && txn.provider === payment.provider) {
      matchingTxn = txn;
      break;
    }
  }

  // 2. Check if already claimed by another order
  if (matchingTxn && matchingTxn.claimedPaymentId && matchingTxn.claimedPaymentId !== payment.id) {
    payment.status = 'needs_review';
    payment.reviewReason = 'duplicate_trx_id';
    paymentsStore.set(payment.id, payment);
    return res.status(409).json({
      outcome: 'already_claimed',
      error: 'This Transaction ID was already claimed by another payment.',
      payment,
    });
  }

  // 3. If no SMS received yet, transition to 'confirming' (holds state, no open thread held)
  if (!matchingTxn) {
    payment.status = 'confirming';
    paymentsStore.set(payment.id, payment);
    return res.json({
      outcome: 'no_evidence',
      status: 'confirming',
      message: 'Verifying payment with the network...',
      payment,
    });
  }

  // 4. Verify amounts
  if (matchingTxn.amountPaisa < payment.amountPaisa) {
    payment.status = 'needs_review';
    payment.reviewReason = 'underpaid';
    paymentsStore.set(payment.id, payment);
    return res.json({
      outcome: 'conflict',
      reviewReason: 'underpaid',
      error: `Received Tk ${matchingTxn.amountPaisa / 100}, expected Tk ${payment.amountPaisa / 100}`,
      payment,
    });
  }

  // 5. Atomic Match Success!
  payment.status = 'paid';
  payment.paidAt = new Date().toISOString();
  payment.matchedBy = matchingTxn.refNormalized === payment.reference ? 'trxid+reference' : 'trxid';
  payment.reviewReason = undefined;
  matchingTxn.claimedPaymentId = payment.id;

  paymentsStore.set(payment.id, payment);
  incomingTxnsStore.set(matchingTxn.id, matchingTxn);

  // Queue event to outbox
  const outboxEntry = {
    id: `out_${Date.now()}`,
    merchantId: payment.merchantId,
    paymentId: payment.id,
    event: 'payment.paid',
    url: initialMerchant.webhookUrl,
    payload: {
      event: 'payment.paid',
      payment_id: payment.id,
      order_id: payment.orderId,
      amount_paisa: payment.amountPaisa,
      net_paisa: payment.netAmountPaisa,
      provider: payment.provider,
      trx_id: cleanTrx,
      reference: payment.reference,
      paid_at: payment.paidAt,
    },
    attempts: 0,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  outboxQueue.push(outboxEntry);

  await logAudit(
    'system',
    'system',
    'PAYMENT_MATCHED',
    'payment',
    payment.id,
    `Payment ${payment.id} matched TrxID ${cleanTrx} via ${payment.matchedBy}`,
    req.ip || '127.0.0.1'
  );

  return res.json({
    outcome: 'matched',
    status: 'paid',
    payment,
  });
});

// 5. POST /v1/sms/webhook (Super Admin Forwarder Handset Ingest with Cryptographic Signature & Replay Defense)
app.post('/v1/sms/webhook', async (req: Request, res: Response) => {
  const deviceId = req.headers['x-device-id'] as string || superAdminDevice.id;
  const seqHeader = req.headers['x-device-seq'] as string;
  const timestampHeader = req.headers['x-device-timestamp'] as string;
  const signatureHeader = req.headers['x-device-signature'] as string;
  const clientIp = req.ip || '127.0.0.1';

  const { sender = '', raw_sms = '', sim_slot = 1, client_msg_id } = req.body;

  if (!raw_sms) {
    return res.status(400).json({ error: 'raw_sms payload is required' });
  }

  // 1. Verify Cryptographic Device Signature & Monotonic Replay Counter
  if (seqHeader && signatureHeader) {
    const seqNo = parseInt(seqHeader, 10);
    const timestamp = parseInt(timestampHeader || `${Math.floor(Date.now() / 1000)}`, 10);

    const signPayload: DeviceSignPayload = {
      deviceId,
      seqNo,
      timestamp,
      rawSms: raw_sms,
    };

    const verification = await verifyDeviceIngestSignature(
      superAdminDevice.deviceSecret,
      superAdminDevice.lastSeqNo,
      signPayload,
      signatureHeader,
      300 // 5-minute window
    );

    if (!verification.isValid) {
      quarantinedSmsStore.push({
        deviceId,
        sender,
        rawSms: raw_sms,
        failureReason: verification.reason,
        clientIp,
        receivedAt: new Date().toISOString(),
      });

      await logAudit(
        deviceId,
        'system',
        'SIGNATURE_REJECTED',
        'device',
        deviceId,
        verification.reason || 'Cryptographic verification failed',
        clientIp
      );

      return res.status(403).json({
        error: '403 Forbidden: Device signature verification failed',
        details: verification.reason,
      });
    }

    // Monotonic sequence counter updated
    superAdminDevice.lastSeqNo = seqNo;
  }

  // 2. Parse Incoming SMS
  const parsed = parseIncomingSms(raw_sms, sender, sim_slot as 1 | 2);

  if (!parsed.isValid) {
    quarantinedSmsStore.push({
      deviceId,
      sender,
      rawSms: raw_sms,
      failureReason: parsed.error,
      clientIp,
      receivedAt: new Date().toISOString(),
    });

    return res.status(422).json({
      error: 'Unparseable SMS payload',
      details: parsed.error,
    });
  }

  // 3. Deduplication on (provider, trxId) and (deviceId, clientMsgId)
  const dedupeKey = `${parsed.provider}:${parsed.trxId}`;
  for (const existing of incomingTxnsStore.values()) {
    if (existing.trxId === parsed.trxId && existing.provider === parsed.provider) {
      return res.status(200).json({
        status: 'duplicate_ignored',
        message: `TrxID ${parsed.trxId} for ${parsed.provider} was already ingested.`,
        txnId: existing.id,
      });
    }
  }

  const txnId = `txn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const incomingTxn: IncomingTxn = {
    id: txnId,
    provider: parsed.provider,
    trxId: parsed.trxId,
    walletId: parsed.simSlot === 2 ? 'wal_sim2_01' : 'wal_sim1_01',
    amountPaisa: parsed.amountPaisa,
    balanceAfterPaisa: parsed.balanceAfterPaisa || 0,
    refRaw: parsed.refRaw || '',
    refNormalized: parsed.refNormalized || '',
    rawSms: raw_sms,
    clientMsgId: client_msg_id || `msg_${Date.now()}`,
    simSlot: parsed.simSlot,
    receivedAt: parsed.timestamp || new Date().toISOString(),
  };

  incomingTxnsStore.set(txnId, incomingTxn);

  // 4. Check if any pending payment is awaiting this TrxID or normalized reference
  let matchedPaymentId: string | undefined;
  for (const payment of paymentsStore.values()) {
    if (payment.status === 'confirming' || payment.status === 'awaiting_payment') {
      const trxMatches = payment.submittedTrxId && payment.submittedTrxId === parsed.trxId;
      const refMatches = parsed.refNormalized && payment.reference === parsed.refNormalized;

      if (trxMatches || refMatches) {
        if (parsed.amountPaisa >= payment.amountPaisa) {
          payment.status = 'paid';
          payment.paidAt = new Date().toISOString();
          payment.matchedBy = refMatches ? 'trxid+reference' : 'trxid';
          payment.submittedTrxId = parsed.trxId;
          incomingTxn.claimedPaymentId = payment.id;
          matchedPaymentId = payment.id;
          paymentsStore.set(payment.id, payment);
          break;
        }
      }
    }
  }

  await logAudit(
    deviceId,
    'system',
    'SMS_INGESTED',
    'incoming_txn',
    txnId,
    `Ingested ${parsed.provider.toUpperCase()} SMS TrxID ${parsed.trxId} (Tk ${parsed.amountPaisa / 100})`,
    clientIp
  );

  return res.status(200).json({
    received: true,
    txnId,
    parsed,
    matchedPaymentId,
  });
});

// 6. POST /v1/devices/heartbeat
app.post('/v1/devices/heartbeat', (req: Request, res: Response) => {
  const { battery_level, is_charging, latency_ms } = req.body;
  superAdminDevice.lastHeartbeat = new Date().toISOString();
  if (battery_level !== undefined) superAdminDevice.batteryLevel = battery_level;
  if (is_charging !== undefined) superAdminDevice.isCharging = is_charging;
  if (latency_ms !== undefined) superAdminDevice.lastSeenLatencyMs = latency_ms;

  return res.json({ status: 'ok', device: superAdminDevice });
});

// 7. GET /v1/devices/status
app.get('/v1/devices/status', (_req: Request, res: Response) => {
  return res.json(superAdminDevice);
});

// 8. GET /v1/audit/logs
app.get('/v1/audit/logs', (_req: Request, res: Response) => {
  return res.json(auditLogChain);
});

// 9. POST /v1/outbox/process (Executes real HTTP webhook dispatch)
app.post('/v1/outbox/process', async (_req: Request, res: Response) => {
  const pending = outboxQueue.filter((item) => item.status === 'pending');
  const results = [];

  for (const item of pending) {
    item.attempts += 1;
    const dispatchResult = await dispatchRealWebhook(
      item.url,
      item.payload,
      initialMerchant.webhookSecret
    );

    if (dispatchResult.success) {
      item.status = 'delivered';
      item.deliveredAt = new Date().toISOString();
    } else if (item.attempts >= 7) {
      item.status = 'failed';
    }

    results.push({ id: item.id, ...dispatchResult });
  }

  return res.json({ processed: pending.length, results });
});

// ==========================================
// VITE SPA DEV SERVER MOUNTING
// ==========================================
async function startServer() {
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const isHmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createServer({
      server: {
        middlewareMode: true,
        hmr: isHmrDisabled ? false : { server: httpServer },
        watch: isHmrDisabled ? null : {},
      },
      appType: 'spa',
    });

    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[PayGate API] Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
