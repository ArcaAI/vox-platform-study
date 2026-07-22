/**
 * Speech proxy E2E (auth gating).
 *
 * Confirms the gateway registers the speech proxy routes and that the global
 * deny-by-default auth guard protects them. Full-path streaming (gateway → tts-v2)
 * is covered by unit tests and a live check; it is not asserted here because it
 * requires the tts-v2 service running with a provider enabled.
 */

import { expect, test } from '@playwright/test';

test.describe('Speech proxy — auth gating', () => {
  test('GET /speech/voices requires authentication', async ({ request }) => {
    const response = await request.get('/api/v1/speech/voices');
    expect(response.status()).toBe(401);
  });

  test('POST /speech/synthesize requires authentication', async ({ request }) => {
    const response = await request.post('/api/v1/speech/synthesize', {
      data: { input: 'Hello.', voice: 'en-female-1' },
    });
    expect(response.status()).toBe(401);
  });
});
