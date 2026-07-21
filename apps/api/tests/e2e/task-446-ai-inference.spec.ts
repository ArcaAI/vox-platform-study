/**
 * User-plane AI inference proxy (`/ai/*`, Agent Playground
 * Guardrails/NER tabs). Verifies the gateway contract against a RUNNING API:
 * deny-by-default auth, strict DTO validation, and that an authenticated
 * user-plane caller REACHES the proxy (never 401/403). The upstream Guardrail
 * (:8863) / NLP (:8864) services are not part of the API e2e infra, so a valid
 * request may resolve to a 2xx (services up) or a 5xx (services down) — either
 * way it must not be an auth rejection.
 *
 * Prerequisites: API server running + seeded users (pnpm test:db:seed).
 */

import { test, expect } from '@playwright/test';
import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const GUARDRAIL_ROUTE = '/api/v1/ai/guardrail/analyze';
const NER_ROUTE = '/api/v1/ai/nlp/entities';

test.describe('TASK-446 AI inference proxy (/ai/*)', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const result = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    token = result?.token ?? '';
  });

  test('rejects unauthenticated requests (deny-by-default)', async ({ request }) => {
    const guardrail = await request.post(GUARDRAIL_ROUTE, { data: { text: 'hello' } });
    expect(guardrail.status()).toBe(401);
    const ner = await request.post(NER_ROUTE, { data: { text: 'hello' } });
    expect(ner.status()).toBe(401);
  });

  test('validates the request body (missing text → 400)', async ({ request }) => {
    test.skip(!token, 'login failed — is the API seeded?');
    const guardrail = await request.post(GUARDRAIL_ROUTE, {
      headers: { Authorization: `Bearer ${token}` },
      data: { guardrailType: 'comprehensive' },
    });
    expect(guardrail.status()).toBe(400);
    const ner = await request.post(NER_ROUTE, {
      headers: { Authorization: `Bearer ${token}` },
      data: {},
    });
    expect(ner.status()).toBe(400);
  });

  test('rejects an unknown guardrailType (whitelist)', async ({ request }) => {
    test.skip(!token, 'login failed — is the API seeded?');
    const response = await request.post(GUARDRAIL_ROUTE, {
      headers: { Authorization: `Bearer ${token}` },
      data: { text: 'hello', guardrailType: 'not_a_type' },
    });
    expect(response.status()).toBe(400);
  });

  test('an authenticated user-plane caller reaches the proxy (never 401/403)', async ({ request }) => {
    test.skip(!token, 'login failed — is the API seeded?');
    const guardrail = await request.post(GUARDRAIL_ROUTE, {
      headers: { Authorization: `Bearer ${token}` },
      data: { text: 'Patient denies chest pain.' },
    });
    expect([401, 403]).not.toContain(guardrail.status());

    const ner = await request.post(NER_ROUTE, {
      headers: { Authorization: `Bearer ${token}` },
      data: { text: 'Prescribed aspirin 100mg daily.' },
    });
    expect([401, 403]).not.toContain(ner.status());
  });
});
