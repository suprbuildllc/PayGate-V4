/**
 * PayGate Typed API Client
 * Connects frontend apps to Express API endpoints (/v1) defined in @paygate/contracts
 */

import {
  CreatePaymentRequest,
  CreatePaymentResponse,
  ConfirmPaymentClaimRequest,
  ConfirmPaymentClaimResponse,
  SmsIngestRequest,
  SmsIngestResponse,
} from '@paygate/contracts';
import { Payment, DeviceInfo } from '../types';

export class PayGateApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl;
  }

  async createPayment(
    data: CreatePaymentRequest,
    idempotencyKey?: string
  ): Promise<CreatePaymentResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) {
      headers['idempotency-key'] = idempotencyKey;
    }

    const res = await fetch(`${this.baseUrl}/v1/payments`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to create payment' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    return res.json();
  }

  async getPayment(id: string): Promise<Payment> {
    const res = await fetch(`${this.baseUrl}/v1/payments/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async getCheckoutPayment(id: string): Promise<{
    payment: Payment;
    isLocked: boolean;
    lockedUntil?: number;
    attemptsRemaining: number;
  }> {
    const res = await fetch(`${this.baseUrl}/v1/pay/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async confirmPaymentClaim(
    paymentId: string,
    trxId: string
  ): Promise<ConfirmPaymentClaimResponse> {
    const res = await fetch(`${this.baseUrl}/v1/pay/${encodeURIComponent(paymentId)}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trx_id: trxId } as ConfirmPaymentClaimRequest),
    });

    return res.json();
  }

  async ingestSms(
    data: SmsIngestRequest,
    deviceHeaders?: {
      deviceId?: string;
      seqNo?: number;
      timestamp?: number;
      signature?: string;
    }
  ): Promise<SmsIngestResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (deviceHeaders?.deviceId) headers['x-device-id'] = deviceHeaders.deviceId;
    if (deviceHeaders?.seqNo !== undefined) headers['x-device-seq'] = String(deviceHeaders.seqNo);
    if (deviceHeaders?.timestamp !== undefined) headers['x-device-timestamp'] = String(deviceHeaders.timestamp);
    if (deviceHeaders?.signature) headers['x-device-signature'] = deviceHeaders.signature;

    const res = await fetch(`${this.baseUrl}/v1/sms/webhook`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });

    return res.json();
  }

  async pingDevice(payload: { battery_level?: number; is_charging?: boolean; latency_ms?: number }): Promise<{
    status: string;
    device: DeviceInfo;
  }> {
    const res = await fetch(`${this.baseUrl}/v1/devices/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  async getDeviceStatus(): Promise<DeviceInfo> {
    const res = await fetch(`${this.baseUrl}/v1/devices/status`);
    return res.json();
  }

  async getAuditLogs(): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/v1/audit/logs`);
    return res.json();
  }

  async processOutbox(): Promise<{ processed: number; results: any[] }> {
    const res = await fetch(`${this.baseUrl}/v1/outbox/process`, { method: 'POST' });
    return res.json();
  }
}

export const apiClient = new PayGateApiClient();
