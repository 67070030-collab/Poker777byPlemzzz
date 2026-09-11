/**
 * Auth & user service — business logic for register / login / profile.
 *
 * All SQL lives in the models (user.model, wallet.model); this layer owns the
 * rules: validation, password hashing, JWT signing, the welcome-bonus policy,
 * and transaction boundaries.
 */
import bcrypt from 'bcryptjs';
import { jwt } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { withTransaction } from '../config/db.js';
import { errors } from '../middleware/errors.js';
import { validate } from '../middleware/validate.js';
import { registerSchema, loginSchema, updateUserSchema } from '../validators/auth.js';
import * as users from '../models/user.model.js';
import * as wallet from '../models/wallet.model.js';

const BCRYPT_COST = 12;

/**
 * Register a new user. Welcome bonus is credited atomically in the same
 * DB transaction so we never end up with a user but no wallet/transaction.
 *
 * Idempotency: ref_id = `register:<userId>` — if re-run after a partial
 * failure it cannot double-credit because the transactions table has a
 * unique constraint on ref_id.
 */
export async function registerUser(input) {
  const { username, email, password } = validate(registerSchema, input);

  // Pre-check to give a nicer 409 (the unique constraints will still reject
  // any race that slips between the check and the insert).
  const clashRow = await users.findLoginConflict({ username, email });
  if (clashRow) {
    const clash = clashRow.username === username ? 'username' : 'email';
    throw errors.conflict(
      clash === 'username' ? 'USERNAME_TAKEN' : 'EMAIL_TAKEN',
      `${clash === 'username' ? 'Username' : 'Email'} already registered`
    );
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const bonus = env.economy.welcomeBonus;

  const userId = await withTransaction(async (conn) => {
    const newUserId = await users.insertUser({ username, email, passwordHash }, conn);
    // Create the wallet with the welcome bonus as the starting balance,
    // then append the matching ledger row (ref_id guarantees idempotency).
    await wallet.createWallet({ userId: newUserId, balance: bonus }, conn);
    await wallet.insertTransaction(
      { userId: newUserId, amount: bonus, type: 'BONUS', refId: `register:${newUserId}`, balanceAfter: bonus },
      conn
    );
    return newUserId;
  });

  const token = signJwt(userId, username);
  return {
    token,
    user: { id: userId, username, email, avatar_id: null, balance: bonus },
  };
}

/**
 * Login by username or email. Single 401 for any failure — do not leak
 * whether the username exists.
 */
export async function loginUser(input) {
  const { identifier, password } = validate(loginSchema, input);

  const user = await users.findByIdentifier(identifier);
  // Always run a bcrypt compare even when not found, to keep timing uniform.
  const dummyHash = '$2a$12$000000000000000000000000000000000000000000000000000000';
  const hash = user ? user.password_hash : dummyHash;
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok) {
    throw errors.unauthorized('Invalid credentials');
  }

  const token = signJwt(String(user.id), user.username);
  return { token, user: { id: String(user.id), username: user.username } };
}

/** Fetch the current user's profile + wallet balance. */
export async function getUserProfile(userId) {
  const u = await users.findProfileById(userId);
  if (!u) throw errors.notFound('User not found');
  return {
    id: String(u.id),
    username: u.username,
    email: u.email,
    display_name: u.display_name,
    avatar_id: u.avatar_id,
    balance: u.balance ?? 0,
    created_at: u.created_at,
  };
}

/** Patch display_name / avatar_id for the current user. */
export async function updateUserProfile(userId, patch) {
  const data = validate(updateUserSchema, patch);

  const affected = await users.updateProfile({
    userId,
    avatar_id: data.avatar_id ?? null,
    display_name: data.display_name ?? null,
  });
  if (affected === 0) throw errors.notFound('User not found');
  return getUserProfile(userId);
}

function signJwt(userId, username) {
  return jwt.sign({ sub: userId, username }, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
    issuer: env.jwt.issuer,
  });
}
