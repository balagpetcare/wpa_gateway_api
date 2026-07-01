export type ProviderCredentials = Record<string, string>;

export type ProviderCreatePaymentInput = {
  sessionId: string;
  merchantId: string;
  orderId: string;
  amount?: number;
  amountMinor: string;
  amountDecimal: string;
  currency: string;
  country?: string;
  purpose: string;
  providerEnvironment?: 'SANDBOX' | 'PRODUCTION';
  customer: {
    name: string;
    email: string;
    phone?: string;
    country?: string;
  };
  merchantContactEmail?: string;
  merchantContactPhone?: string;
  successUrl: string;
  cancelUrl: string;
  callbackUrl: string;
  credentials: ProviderCredentials;
};

export type ProviderCreatePaymentResult = {
  providerSessionId: string;
  providerReference: string;
  checkoutToken?: string;
  rawResponse: Record<string, unknown>;
};

export type ProviderVerifyPaymentInput = {
  providerReference: string;
  providerSessionId?: string;
  merchantTransactionId?: string;
  providerTransactionId?: string;
  credentials: ProviderCredentials;
};

export type ProviderVerifyPaymentResult = {
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  providerReference: string;
  providerSessionId?: string;
  rawResponse: Record<string, unknown>;
};

export type ProviderHandleWebhookInput = {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  method?: string;
  credentials: ProviderCredentials;
};

export type ProviderHandleWebhookResult = {
  isVerified: boolean;
  providerEventId: string;
  merchantId?: string;
  merchantOrderId?: string;
  providerReference?: string;
  providerSessionId?: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
  payload: Record<string, unknown>;
};

export type ProviderRefundPaymentInput = {
  providerReference: string;
  amount?: number;
  reason?: string;
  credentials: ProviderCredentials;
};

export type ProviderRefundPaymentResult = {
  refundReference: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  rawResponse: Record<string, unknown>;
};

export interface PaymentProviderAdapter {
  createPayment(input: ProviderCreatePaymentInput): Promise<ProviderCreatePaymentResult>;
  verifyPayment(input: ProviderVerifyPaymentInput): Promise<ProviderVerifyPaymentResult>;
  handleWebhook(input: ProviderHandleWebhookInput): Promise<ProviderHandleWebhookResult>;
  refundPayment(input: ProviderRefundPaymentInput): Promise<ProviderRefundPaymentResult>;
}
