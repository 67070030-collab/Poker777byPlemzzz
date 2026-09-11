/**
 * Wallet Routes — POST /wallet/topup, GET /wallet/transactions, POST /internal/wallet/adjust
 *
 * Note the two different guards: the user-facing endpoints use requireAuth
 * (JWT); the server-to-server adjust endpoint uses requireInternalKey.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireInternalKey } from '../middleware/internalAuth.js';
import * as walletController from '../controllers/wallet.controller.js';

export const router = Router();

router.post('/wallet/topup', requireAuth, walletController.topup);
router.get('/wallet/transactions', requireAuth, walletController.transactions);
router.post('/internal/wallet/adjust', requireInternalKey, walletController.adjust);
