/**
 * Wallet controller — HTTP glue for /wallet/* and /internal/wallet/adjust.
 * The internal-key check is a route-level middleware (requireInternalKey);
 * here we only validate the presence of the body fields and delegate.
 */
import { asyncHandler } from '../middleware/errorHandler.js';
import { ApiError } from '../middleware/errors.js';
import { topUp, getTransactions, adjustWallet } from '../services/wallet.js';

export const topup = asyncHandler(async (req, res) => {
  const result = await topUp(req.user.id, req.body.amount);
  res.json(result);
});

export const transactions = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const result = await getTransactions(req.user.id, page, limit);
  res.json(result);
});

export const adjust = asyncHandler(async (req, res) => {
  const { user_id, amount, ref_id, note } = req.body;
  if (!user_id) throw new ApiError('MISSING_USER_ID', 'user_id is required');
  if (amount === undefined || amount === null) throw new ApiError('MISSING_AMOUNT', 'amount is required');
  if (!ref_id) throw new ApiError('MISSING_REF_ID', 'ref_id is required');
  const result = await adjustWallet(user_id, amount, ref_id, note);
  res.json(result);
});
