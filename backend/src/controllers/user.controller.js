/**
 * User controller — HTTP glue for /users/me (profile read + patch).
 * requireAuth (mounted in the route) has already set req.user.
 */
import { asyncHandler } from '../middleware/errorHandler.js';
import { getUserProfile, updateUserProfile } from '../services/auth.js';

export const getMe = asyncHandler(async (req, res) => {
  res.json({ user: await getUserProfile(req.user.id) });
});

export const updateMe = asyncHandler(async (req, res) => {
  res.json({ user: await updateUserProfile(req.user.id, req.body) });
});
