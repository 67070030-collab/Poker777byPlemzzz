import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as userController from '../controllers/user.controller.js';

export const router = Router();

// All /users/* routes require a valid JWT.
router.use(requireAuth);

router.get('/me', userController.getMe);
router.patch('/me', userController.updateMe);
