export type ApiErrorCode =
  | 'INVALID_SIGNATURE'
  | 'TIMESTAMP_EXPIRED'
  | 'REPLAY_DETECTED'
  | 'DOMAIN_NOT_ALLOWED'
  | 'MERCHANT_INACTIVE'
  | 'KEY_REVOKED'
  | 'KEY_EXPIRED'
  | 'SESSION_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_INIT_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'UNSUPPORTED_CURRENCY'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_PAIR'
  | 'RATE_NOT_FOUND'
  | 'STALE_RATE'
  | 'INTERNAL_SERVER_ERROR'
  | 'INVALID_TRANSACTION_STATE'
  | 'ALREADY_REFUNDED'
  | 'REFUND_IN_PROGRESS'
  | 'INVALID_REFUND_AMOUNT'
  | 'MERCHANT_FILTER_REQUIRED';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export const sendError = (reply: { status: (code: number) => { send: (payload: unknown) => unknown } }, request: { id: string }, error: ApiError) =>
  reply.status(error.statusCode).send({
    error: {
      code: error.code,
      message: error.message,
      request_id: request.id
    }
  });
