/**
 * Internal-key guard for server-to-server endpoints (the Game/WS team calling
 * /internal/wallet/adjust). Not a user JWT — a shared secret sent as the
 * `X-Internal-Key` header. Keep the error code stable (see docs/CONTRACTS.md).
 */
import { env } from '../config/env.js';
import { ApiError } from './errors.js';

export function requireInternalKey(req, res, next) {
  const key = req.headers['x-internal-key'];
  if (!key || key !== env.internalApiKey) {
    return next(new ApiError('INVALID_INTERNAL_KEY', 'Invalid internal API key', 401));
  }
  next();
}
