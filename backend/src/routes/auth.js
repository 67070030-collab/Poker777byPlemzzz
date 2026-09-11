import { Router } from 'express';
import { authLimiter } from '../middleware/rateLimit.js';
import * as authController from '../controllers/auth.controller.js';

export const router = Router();

router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);
