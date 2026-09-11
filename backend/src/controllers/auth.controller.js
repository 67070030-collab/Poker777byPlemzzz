/**
 * Auth controller — HTTP glue for /auth/*. Thin by design: parse the request,
 * call the service, shape the response. All rules live in services/auth.js.
 */
import { asyncHandler } from '../middleware/errorHandler.js';
import { registerUser, loginUser } from '../services/auth.js';

export const register = asyncHandler(async (req, res) => {
  const result = await registerUser(req.body);
  res.status(201).json(result);
});

export const login = asyncHandler(async (req, res) => {
  const result = await loginUser(req.body);
  res.json(result);
});
