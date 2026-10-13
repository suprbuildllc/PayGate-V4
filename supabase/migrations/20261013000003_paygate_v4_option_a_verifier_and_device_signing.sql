-- ============================================================================
-- PayGate Platform v4.0 — Migration 0009: Option A Verifier Model,
-- Device Signature Authentication & Atomic Postgres Claim Engine
-- Database Engine: PostgreSQL 15+ / Supabase
-- ============================================================================

-- 1. Anti-Collision & Idempotency Constraints
DO $$
BEGIN
  -- Unique constraint on incoming_txns per provider and TrxID
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'incoming_txn_per_provider'
  ) THEN
    ALTER TABLE public.incoming_txns
      ADD CONSTRAINT incoming_txn_per_provider UNIQUE (provider, trx_id);
  END IF;

  -- Unique constraint on incoming_txns per device and clientMsgId
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'incoming_txn_dedupe'
  ) THEN
    ALTER TABLE public.incoming_txns
      ADD CONSTRAINT incoming_txn_dedupe UNIQUE (device_id, client_msg_id);
  END IF;
END $$;

-- Unique constraint on payment references
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_reference ON public.payments (reference);

-- Unique index ensuring an SMS can only be claimed once
CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_claimed_once ON public.incoming_txns (matched_payment_id)
  WHERE matched_payment_id IS NOT NULL;

-- 2. Upgrade devices table with public key and monotonic sequence counter
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS public_key TEXT,
  ADD COLUMN IF NOT EXISTS last_seq_no BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS secret_hash TEXT;

-- 3. Quarantined SMS Table for failed parses, unauthorized senders, or signature rejections
CREATE TABLE IF NOT EXISTS public.quarantined_sms (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      VARCHAR(64),
  sender         VARCHAR(64),
  raw_sms        TEXT NOT NULL,
  failure_reason TEXT NOT NULL,
  client_ip      VARCHAR(64),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Transactional Outbox for Reliable Webhook Dispatch
CREATE TABLE IF NOT EXISTS public.outbox (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      UUID NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  payment_id       VARCHAR(64) REFERENCES public.payments(id) ON DELETE CASCADE,
  event            VARCHAR(64) NOT NULL,
  url              TEXT NOT NULL,
  payload          JSONB NOT NULL,
  signature_header TEXT NOT NULL,
  attempts         INT NOT NULL DEFAULT 0,
  max_attempts     INT NOT NULL DEFAULT 7,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status           VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending, delivered, failed
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON public.outbox (status, next_attempt_at)
  WHERE status = 'pending';

-- 5. Add hash chaining fields to audit_logs
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS sequence_no BIGINT GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN IF NOT EXISTS previous_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  ADD COLUMN IF NOT EXISTS entry_hash TEXT;

-- 6. Atomic Stored Procedure: claim_payment (Option A: Verifier Model)
CREATE OR REPLACE FUNCTION public.fn_claim_payment_v4(
  p_payment_id VARCHAR(64),
  p_claim_trx_id VARCHAR(64)
)
RETURNS TABLE (
  match_outcome VARCHAR(32),
  matched_amount_paisa BIGINT,
  review_reason VARCHAR(32),
  error_message TEXT
) AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_incoming public.incoming_txns%ROWTYPE;
  v_clean_trx VARCHAR(64);
BEGIN
  v_clean_trx := UPPER(TRIM(p_claim_trx_id));

  -- Step 1: Lock payment row for update (prevents concurrent claims)
  SELECT * INTO v_payment 
  FROM public.payments 
  WHERE id = p_payment_id 
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'error'::VARCHAR(32), 0::BIGINT, NULL::VARCHAR(32), 'Payment not found'::TEXT;
    RETURN;
  END IF;

  -- Verify payment state is eligible
  IF v_payment.status NOT IN ('awaiting_payment', 'confirming') THEN
    RETURN QUERY SELECT 'not_claimable'::VARCHAR(32), v_payment.amount_paisa, NULL::VARCHAR(32), ('Payment is already in ' || v_payment.status || ' status')::TEXT;
    RETURN;
  END IF;

  -- Check expiration window
  IF NOW() > v_payment.expires_at THEN
    UPDATE public.payments
    SET status = 'needs_review',
        review_reason = 'late_after_expiry',
        submitted_trx_id = v_clean_trx
    WHERE id = p_payment_id;

    RETURN QUERY SELECT 'expired_claim'::VARCHAR(32), 0::BIGINT, 'late_after_expiry'::VARCHAR(32), 'Payment window expired before claim'::TEXT;
    RETURN;
  END IF;

  -- Step 2: Lock incoming SMS transaction
  SELECT * INTO v_incoming 
  FROM public.incoming_txns 
  WHERE provider = v_payment.provider 
    AND trx_id = v_clean_trx
  FOR UPDATE;

  -- If no SMS evidence arrived yet, transition payment to 'confirming'
  IF NOT FOUND THEN
    UPDATE public.payments
    SET status = 'confirming',
        submitted_trx_id = v_clean_trx
    WHERE id = p_payment_id;

    RETURN QUERY SELECT 'no_evidence'::VARCHAR(32), 0::BIGINT, NULL::VARCHAR(32), 'No SMS evidence matching TrxID received yet'::TEXT;
    RETURN;
  END IF;

  -- Step 3: Check if this SMS was already claimed by another payment
  IF v_incoming.matched_payment_id IS NOT NULL AND v_incoming.matched_payment_id <> p_payment_id THEN
    UPDATE public.payments 
    SET status = 'needs_review', 
        review_reason = 'duplicate_trx_id',
        review_notes = 'TrxID was already claimed by payment ' || v_incoming.matched_payment_id,
        submitted_trx_id = v_clean_trx
    WHERE id = p_payment_id;

    RETURN QUERY SELECT 'already_claimed'::VARCHAR(32), v_incoming.amount_paisa, 'duplicate_trx_id'::VARCHAR(32), 'This Transaction ID was already claimed by another order'::TEXT;
    RETURN;
  END IF;

  -- Step 4: Verify Amount (underpaid or overpaid)
  IF v_incoming.amount_paisa < v_payment.amount_paisa THEN
    UPDATE public.payments 
    SET status = 'needs_review', 
        review_reason = 'underpaid',
        review_notes = 'Expected ' || v_payment.amount_paisa || ' paisa but received ' || v_incoming.amount_paisa || ' paisa',
        submitted_trx_id = v_clean_trx
    WHERE id = p_payment_id;

    RETURN QUERY SELECT 'conflict'::VARCHAR(32), v_incoming.amount_paisa, 'underpaid'::VARCHAR(32), 'Amount received is less than invoiced amount'::TEXT;
    RETURN;
  ELSIF v_incoming.amount_paisa > v_payment.amount_paisa THEN
    UPDATE public.payments 
    SET status = 'needs_review', 
        review_reason = 'overpaid',
        review_notes = 'Expected ' || v_payment.amount_paisa || ' paisa but received ' || v_incoming.amount_paisa || ' paisa',
        submitted_trx_id = v_clean_trx
    WHERE id = p_payment_id;

    RETURN QUERY SELECT 'conflict'::VARCHAR(32), v_incoming.amount_paisa, 'overpaid'::VARCHAR(32), 'Amount received exceeds invoiced amount'::TEXT;
    RETURN;
  END IF;

  -- Step 5: Check Reference Cross-Check
  IF v_incoming.ref_normalized IS NOT NULL AND v_incoming.ref_normalized <> '' AND v_incoming.ref_normalized <> v_payment.reference THEN
    UPDATE public.payments 
    SET status = 'needs_review', 
        review_reason = 'unmatched_reference',
        review_notes = 'SMS reference (' || v_incoming.ref_normalized || ') differs from expected reference (' || v_payment.reference || ')',
        submitted_trx_id = v_clean_trx
    WHERE id = p_payment_id;

    RETURN QUERY SELECT 'conflict'::VARCHAR(32), v_incoming.amount_paisa, 'unmatched_reference'::VARCHAR(32), 'Reference in confirmation SMS does not match invoice'::TEXT;
    RETURN;
  END IF;

  -- Step 6: Atomic Match Confirmed!
  UPDATE public.payments
  SET status = 'paid',
      submitted_trx_id = v_clean_trx,
      matched_at = NOW(),
      review_reason = NULL
  WHERE id = p_payment_id;

  UPDATE public.incoming_txns
  SET matched_payment_id = p_payment_id
  WHERE id = v_incoming.id;

  -- Step 7: Queue Webhook Event in Outbox
  INSERT INTO public.outbox (
    merchant_id, payment_id, event, url, payload, signature_header
  )
  SELECT 
    m.id, 
    p_payment_id, 
    'payment.paid', 
    COALESCE(m.webhook_url, ''), 
    jsonb_build_object(
      'event', 'payment.paid',
      'payment_id', p_payment_id,
      'order_id', v_payment.order_id,
      'amount_paisa', v_payment.amount_paisa,
      'net_paisa', v_payment.net_amount_paisa,
      'provider', v_payment.provider,
      'trx_id', v_clean_trx,
      'reference', v_payment.reference,
      'paid_at', NOW()
    ),
    'pending_signature'
  FROM public.merchants m
  WHERE m.id = v_payment.merchant_id;

  RETURN QUERY SELECT 'matched'::VARCHAR(32), v_incoming.amount_paisa, NULL::VARCHAR(32), NULL::TEXT;
END;
$$ LANGUAGE plpgsql;
