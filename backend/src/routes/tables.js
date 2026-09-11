/**
 * Table HTTP routes — lobby + join preview (REST).
 *
 * The realtime game (WebSocket, rules, broadcast) lives under `../game/`.
 * Handlers live in ../controllers/table.controller.js; this file only maps
 * paths to them.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as tableController from '../controllers/table.controller.js';

export const router = Router();
router.use(requireAuth);

router.get('/', tableController.list);
router.post('/', tableController.create);
router.get('/:room_code', tableController.getByCode);
router.post('/:room_code/join', tableController.join);
