/**
 * Routing / wiring tests — verify the MVC layers connect correctly
 * (route → middleware → controller → error shape) WITHOUT a database.
 *
 * Everything asserted here rejects before any SQL runs: auth/internal-key
 * guards, 404s, and request validation. That makes this suite runnable
 * anywhere (no MySQL), and it's the guardrail for the routes/controllers
 * refactor. The DB-backed behaviour is covered by auth/tables/wallet tests.
 *
 * Run standalone: node --test src/test/routing.test.js
 */
process.env.NODE_ENV = 'test';
process.env.REDIS_DISABLED = '1';

import { test, after } from 'node:test';
import assert from 'node:assert';
import supertest from 'supertest';
import { createApp } from '../server.js';
import { pool } from '../config/db.js';

const request = supertest(await createApp());

after(async () => {
  await pool.end();
});

test('GET /health -> 200 ok (no auth)', async () => {
  const r = await request.get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('unknown route -> 404 NOT_FOUND', async () => {
  const r = await request.get('/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');
});

test('GET /users/me without token -> 401 (auth guard mounted)', async () => {
  const r = await request.get('/users/me');
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'UNAUTHORIZED');
});

test('GET /users/me with malformed token -> 401', async () => {
  const r = await request.get('/users/me').set('Authorization', 'Bearer not.a.jwt');
  assert.equal(r.status, 401);
});

test('POST /tables without token -> 401 (auth guard mounted)', async () => {
  const r = await request.post('/tables').send({ name: 'x' });
  assert.equal(r.status, 401);
});

test('POST /wallet/topup without token -> 401', async () => {
  const r = await request.post('/wallet/topup').send({ amount: 100 });
  assert.equal(r.status, 401);
});

test('POST /internal/wallet/adjust without key -> 401 INVALID_INTERNAL_KEY (internal guard)', async () => {
  const r = await request.post('/internal/wallet/adjust').send({ user_id: '1', amount: 1, ref_id: 'x' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'INVALID_INTERNAL_KEY');
});

test('POST /internal/wallet/adjust wrong key -> 401', async () => {
  const r = await request
    .post('/internal/wallet/adjust')
    .set('X-Internal-Key', 'wrong-key')
    .send({ user_id: '1', amount: 1, ref_id: 'x' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'INVALID_INTERNAL_KEY');
});

test('POST /auth/register with invalid input -> 400 BAD_REQUEST (validation reaches controller)', async () => {
  // validation throws before any DB access, so this is safe without MySQL.
  const r = await request.post('/auth/register').send({ username: 'ab', email: 'nope', password: '123' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'BAD_REQUEST');
  assert.ok(Array.isArray(r.body.error.details));
});
